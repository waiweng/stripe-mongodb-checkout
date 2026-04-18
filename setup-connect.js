/**
 * One-time script: creates a Stripe Connect Express account for "Malay Kitchen" (test mode).
 * Run: node setup-connect.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const OUTPUT_FILE = path.join(__dirname, '.connected-account-id');

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Set STRIPE_SECRET_KEY in .env');
    process.exit(1);
  }

  // Create a Connect Express account so the platform can route charges with application fees (destination charges).
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'AU',
    email: 'malay-kitchen@foodnow-demo.com',
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      name: 'Malay Kitchen',
      mcc: '5812',
    },
  });

  console.log('');
  console.log('Connected account ID:', account.id);
  console.log('');

  fs.writeFileSync(OUTPUT_FILE, account.id, 'utf8');
  console.log('Saved to', OUTPUT_FILE);
  console.log('');

  console.log('==============================================');
  console.log('FOODNOW CONNECT SETUP COMPLETE');
  console.log('==============================================');
  console.log('1. Copy the account ID above to your .env file');
  console.log('   RESTAURANT_CONNECTED_ACCOUNT_ID=acct_...');
  console.log('');
  console.log('2. In Stripe Dashboard test mode, go to:');
  console.log('   Connect > Accounts > find Malay Kitchen');
  console.log('   Skip the onboarding for test mode');
  console.log('');
  console.log('3. Run: node seed-foodnow.js');
  console.log('4. Run: npm start');
  console.log('5. Visit: http://localhost:3000/foodnow');
  console.log('==============================================');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
