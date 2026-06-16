const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/school-ai';

async function createIndexes() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('elevenlabswebhooks');

    // Create compound indexes for daily-insights queries
    console.log('Creating index: { type: 1, schoolId: 1, received_at: -1 }');
    await collection.createIndex(
      { type: 1, schoolId: 1, received_at: -1 },
      { name: 'type_schoolId_received_at_idx' }
    );

    console.log('Creating index: { type: 1, schoolId: 1, received_at: -1, tour_booking_detected: 1, actionTaken: 1 }');
    await collection.createIndex(
      { type: 1, schoolId: 1, received_at: -1, tour_booking_detected: 1, actionTaken: 1 },
      { name: 'action_needed_query_idx' }
    );

    const leadInsightsCollection = db.collection('leadinsights');
    console.log('Creating lead insight index: { schoolId: 1, webhookId: 1 }');
    await leadInsightsCollection.createIndex(
      { schoolId: 1, webhookId: 1 },
      { unique: true, name: 'schoolId_webhookId_unique_idx' }
    );
    console.log('Creating lead insight index: { schoolId: 1, actionNeededEligible: 1, callTimestamp: -1 }');
    await leadInsightsCollection.createIndex(
      { schoolId: 1, actionNeededEligible: 1, callTimestamp: -1 },
      { name: 'schoolId_actionNeeded_callTimestamp_idx' }
    );

    const alertsCollection = db.collection('alerts');
    console.log('Creating alert index: { dedupeKey: 1, status: 1, lastOccurredAt: -1 }');
    await alertsCollection.createIndex(
      { dedupeKey: 1, status: 1, lastOccurredAt: -1 },
      { name: 'dedupe_status_lastOccurred_idx' }
    );
    console.log('Creating alert index: { severity: 1, status: 1, lastOccurredAt: -1 }');
    await alertsCollection.createIndex(
      { severity: 1, status: 1, lastOccurredAt: -1 },
      { name: 'severity_status_lastOccurred_idx' }
    );
    console.log('Creating alert index: { schoolId: 1, lastOccurredAt: -1 }');
    await alertsCollection.createIndex(
      { schoolId: 1, lastOccurredAt: -1 },
      { name: 'schoolId_lastOccurred_idx' }
    );
    console.log('Creating alert index: { type: 1, lastOccurredAt: -1 }');
    await alertsCollection.createIndex(
      { type: 1, lastOccurredAt: -1 },
      { name: 'type_lastOccurred_idx' }
    );

    console.log('Indexes created successfully');
  } catch (err) {
    console.error('Error creating indexes:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

createIndexes();
