const cron = require('node-cron');
const TourBooking = require('../models/TourBooking');
const School = require('../models/School');
const Followup = require('../models/Followup');
const { sendTourConfirmation } = require('./automation');
const AlertService = require('./alertService');

/**
 * Initialize background cron jobs for reminders and follow-ups
 */
function initReminderService() {
    console.log('[Reminder Service] Initializing cron jobs...');

    // Run every hour to check for reminders and follow-ups
    cron.schedule('0 * * * *', async () => {
        console.log('[Reminder Service] Running hourly check...');
        const started = Date.now();
        try {
            await sendUpcomingReminders();
            await sendPostTourFollowups();
            const elapsed = Date.now() - started;
            if (elapsed > 5 * 60 * 1000) {
                AlertService.create({
                    type: 'CRON_ERROR',
                    severity: 'WARNING',
                    title: 'Reminder cron job ran long',
                    message: `Hourly reminder job took ${Math.round(elapsed / 1000)}s`,
                    source: 'reminderService.cron',
                    metadata: { elapsedMs: elapsed },
                });
            }
        } catch (err) {
            console.error('[Reminder Service] Cron job failed:', err);
            AlertService.create({
                type: 'CRON_ERROR',
                severity: 'CRITICAL',
                title: 'Reminder cron job failed',
                message: err.message,
                source: 'reminderService.cron',
                metadata: { stack: err.stack },
            });
        }
    });
}

/**
 * Send SMS reminders for tours happening tomorrow (24h before)
 */
async function sendUpcomingReminders() {
    try {
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const soon = new Date(tomorrow.getTime() + 65 * 60 * 1000); // 1h buffer

        // Find bookings scheduled between 24 and 25 hours from now
        const bookings = await TourBooking.find({
            scheduledAt: { $gte: tomorrow, $lt: soon },
            reminderSent: false
        });

        console.log(`[Reminder Service] Found ${bookings.length} upcoming tours for reminders.`);

        for (const booking of bookings) {
            const school = await School.findById(booking.schoolId);
            if (!school) continue;


            booking.reminderSent = true;
            await booking.save();
        }
    } catch (err) {
        console.error('[Reminder Service] Error in upcoming reminders:', err);
        AlertService.create({
            type: 'CRON_ERROR',
            severity: 'WARNING',
            title: 'Upcoming tour reminders failed',
            message: err.message,
            source: 'reminderService.sendUpcomingReminders',
            metadata: { stack: err.stack },
        });
    }
}

/**
 * Send SMS/Email follow-up "Thank you" 24 hours AFTER the tour
 */
async function sendPostTourFollowups() {
    try {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const older = new Date(yesterday.getTime() - 65 * 60 * 1000);

        // Find bookings that happened exactly 24h ago
        const bookings = await TourBooking.find({
            scheduledAt: { $gte: older, $lt: yesterday },
            followupSent: false
        });

        console.log(`[Reminder Service] Found ${bookings.length} completed tours for follow-ups.`);

        for (const booking of bookings) {
            const school = await School.findById(booking.schoolId);
            if (!school) continue;


            booking.followupSent = true;
            await booking.save();
        }
    } catch (err) {
        console.error('[Reminder Service] Error in post-tour follow-ups:', err);
        AlertService.create({
            type: 'CRON_ERROR',
            severity: 'WARNING',
            title: 'Post-tour follow-ups failed',
            message: err.message,
            source: 'reminderService.sendPostTourFollowups',
            metadata: { stack: err.stack },
        });
    }
}


module.exports = { initReminderService };
