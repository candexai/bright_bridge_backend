const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const School = require('./models/School');
const User = require('./models/User');
const Integration = require('./models/Integration');
const ReferralLink = require('./models/ReferralLink');
const AlertService = require('./services/alertService');

let mongooseEventsRegistered = false;
let isShuttingDown = false;
let disconnectAlertTimer = null;

/** Wait before CRITICAL email — Atlas/local blips often reconnect within seconds. */
const DISCONNECT_ALERT_DELAY_MS = parseInt(process.env.MONGODB_DISCONNECT_ALERT_DELAY_MS || '30000', 10);

function registerShutdownHandlers() {
    const markShuttingDown = () => {
        isShuttingDown = true;
        if (disconnectAlertTimer) {
            clearTimeout(disconnectAlertTimer);
            disconnectAlertTimer = null;
        }
    };
    process.once('SIGINT', markShuttingDown);
    process.once('SIGTERM', markShuttingDown);
    process.once('beforeExit', markShuttingDown);
}

function registerMongooseConnectionAlerts() {
    if (mongooseEventsRegistered) return;
    mongooseEventsRegistered = true;
    registerShutdownHandlers();

    mongoose.connection.on('disconnected', () => {
        console.warn('[Database] MongoDB disconnected (may be transient — waiting before alert)');

        if (disconnectAlertTimer) clearTimeout(disconnectAlertTimer);

        if (isShuttingDown) {
            console.log('[Database] Skip disconnect alert — server is shutting down');
            return;
        }

        disconnectAlertTimer = setTimeout(() => {
            disconnectAlertTimer = null;
            if (isShuttingDown) return;
            if (mongoose.connection.readyState === 1) {
                console.log('[Database] Skip disconnect alert — already reconnected');
                return;
            }
            console.error('[Database] MongoDB still disconnected — creating CRITICAL alert');
            AlertService.create({
                type: 'DATABASE_ERROR',
                severity: 'CRITICAL',
                title: 'MongoDB disconnected',
                message: 'Mongoose connection has been down for more than 30 seconds. The app cannot read or write data until MongoDB is back.',
                source: 'database.mongoose',
                metadata: { event: 'disconnected', sustainedMs: DISCONNECT_ALERT_DELAY_MS },
            });
        }, DISCONNECT_ALERT_DELAY_MS);
    });

    mongoose.connection.on('reconnected', () => {
        if (disconnectAlertTimer) {
            clearTimeout(disconnectAlertTimer);
            disconnectAlertTimer = null;
            console.log('[Database] MongoDB reconnected — cancelled pending disconnect alert');
        } else {
            console.log('[Database] MongoDB reconnected');
        }
        // Recovery is logged only — no email (avoid noise after brief blips)
        AlertService.create({
            type: 'DATABASE_ERROR',
            severity: 'INFO',
            title: 'MongoDB reconnected',
            message: 'Mongoose connection re-established after a brief interruption.',
            source: 'database.mongoose',
            metadata: { event: 'reconnected' },
        });
    });

    mongoose.connection.on('error', (err) => {
        console.error('[Database] MongoDB connection error:', err.message);
        if (isShuttingDown) return;
        AlertService.create({
            type: 'DATABASE_ERROR',
            severity: 'CRITICAL',
            title: 'MongoDB connection error',
            message: err.message,
            source: 'database.mongoose',
            metadata: { stack: err.stack, event: 'error' },
        });
    });
}

async function connectDatabase() {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/childcare-enrollment-ai';
    registerMongooseConnectionAlerts();
    try {
        await mongoose.connect(uri);
        console.log('✅ Connected to MongoDB');
    } catch (err) {
        AlertService.create({
            type: 'DATABASE_ERROR',
            severity: 'CRITICAL',
            title: 'MongoDB initial connection failed',
            message: err.message,
            source: 'database.connect',
            metadata: { stack: err.stack },
        });
        throw err;
    }
}

/**
 * Existing schools should not auto-start the product tour.
 * Only schools created after this field exists keep status: pending (schema default).
 */
async function migrateProductTourDefaults() {
    const result = await School.updateMany(
        {
            $or: [
                { productTour: { $exists: false } },
                { 'productTour.status': { $exists: false } },
                { 'productTour.status': null },
            ],
        },
        {
            $set: {
                productTour: {
                    status: 'completed',
                    currentStepId: null,
                    completedAt: new Date(),
                    skippedSteps: [],
                },
            },
        }
    );
    if (result.modifiedCount > 0) {
        console.log(`ℹ️  Migrated productTour → completed for ${result.modifiedCount} existing school(s)`);
    }
}

async function seedDatabase() {
    await migrateProductTourDefaults();

    // Check if data already exists
    const userCount = await User.countDocuments();
    if (userCount > 0) {
        console.log('ℹ️  Database already seeded, skipping...');
        return;
    }

    console.log('🌱 Seeding database...');

    const adminPasswordHash = bcrypt.hashSync('admin123', 10);
    const schoolPasswordHash = bcrypt.hashSync('school123', 10);

    // Create schools
    const schoolsData = [
        { name: 'Sunshine Childcare', aiNumber: '+1 (555) 123-4567', routingNumber: '+1 (555) 123-4568', status: 'active' },
    ];

    const schools = await School.insertMany(schoolsData);

    // Create admin user
    await User.create({
        email: 'admin@enrollmentai.com',
        passwordHash: adminPasswordHash,
        name: 'Admin',
        role: 'admin',
        schoolId: null,
    });

    // Create school users
    const schoolUsers = [
        { email: 'sunshine@school.com', name: 'Sunshine Admin', schoolId: schools[0]._id },
    ];

    await User.insertMany(
        schoolUsers.map(u => ({
            ...u,
            passwordHash: schoolPasswordHash,
            role: 'school',
        }))
    );

    // Create integrations for each school
    const integrations = [];
    schools.forEach(school => {
        integrations.push(
            { schoolId: school._id, type: 'outlook', name: 'Microsoft Outlook', connected: false },
            { schoolId: school._id, type: 'google', name: 'Google Workspace', connected: false },
        );
    });
    await Integration.insertMany(integrations);

    // Referral links for schools (no mock referrals)
    await ReferralLink.insertMany(
        schools.map(school => ({
            schoolId: school._id,
            code: `ref-${school.name.toLowerCase().replace(/\s+/g, '-')}`,
        }))
    );

    console.log('✅ Database seeded (users, schools, integrations). No mock call/followup data.');
}

module.exports = { connectDatabase, seedDatabase };
