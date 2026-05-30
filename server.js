require('dotenv').config();
process.env.TZ = 'America/Chicago'; // Force global execution context to CST timezone
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const { connectDatabase, seedDatabase } = require('./src/database');

const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const schoolRoutes = require('./src/routes/school');
const voiceRoutes = require('./src/routes/voice');
const integrationRoutes = require('./src/routes/integrations');
const translateRoutes = require('./src/routes/translate');
const publicRoutes = require('./src/routes/public');
const webhookRoutes = require('./src/routes/webhook');
const billingRoutes = require('./src/routes/billing');
const paypalWebhookRoutes = require('./src/routes/paypalWebhook');

const app = express();
const PORT = process.env.PORT || 5001;

// CORS: allow env CORS_ORIGINS (comma-separated) in production, else localhost
const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5001'];
app.use(cors({
    origin: corsOrigins,
    credentials: true,
}));
app.use(compression());
app.use('/api/v1/webhook/paypal', express.raw({ type: 'application/json' }), paypalWebhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/school', schoolRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/integrations', integrationRoutes.router);
app.use('/api', translateRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/billing', billingRoutes);

// Health check
const { runHealthChecks } = require('./src/services/healthService');
app.get('/api/health', async (req, res) => {
    try {
        const result = await runHealthChecks();
        const httpStatus = result.status === 'down' ? 503 : 200;
        res.status(httpStatus).json(result);
    } catch (err) {
        res.status(503).json({
            status: 'down',
            timestamp: new Date().toISOString(),
            error: err.message,
        });
    }
});

const { errorHandler } = require('./src/middleware/errorHandler');
app.use(errorHandler);

// Connect to MongoDB and start server
async function start() {
    try {
        await connectDatabase();
        await seedDatabase();

        // Start background services
        const { initReminderService } = require('./src/services/reminderService');
        initReminderService();

        app.listen(PORT, () => {
            console.log(`\n🚀 Childcare Enrollment AI Backend`);
            console.log(`   Server running on http://localhost:${PORT}`);
            console.log(`   Database: MongoDB`);
            console.log(`   API Health: http://localhost:${PORT}/api/health`);
            console.log(`\n📋 Default Credentials:`);
            console.log(`   Admin: admin@enrollmentai.com / admin123`);
            console.log(`   School: sunshine@school.com / school123\n`);
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err.message);
        process.exit(1);
    }
}

start();
