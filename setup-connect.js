require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');

async function setupConnectedAccount() {

  // Step 1: Create the account with full test bypass data
  // Stripe recognises specific test values that skip all verification:
  // - dob year 1901 = auto-verified identity
  // - id_number '000000000' = auto-verified government ID
  // - bank account number '000123456' = auto-verified bank account
  // - tos_acceptance with current timestamp = terms accepted
  // None of these require real documents or a real ABN

  const account = await stripe.accounts.create({
    type: 'custom',
    country: 'AU',
    email: 'malay-kitchen@foodnow-demo.com',
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: 'individual',
    business_profile: {
      mcc: '5812',
      name: 'Malay Kitchen',
      url: 'https://malay-kitchen-demo.com',
      product_description: 'Malaysian restaurant on FoodNow',
    },
    individual: {
      first_name: 'Jenny',
      last_name: 'Rosen',
      email: 'malay-kitchen@foodnow-demo.com',
      phone: '+61400000000',
      dob: {
        day: 1,
        month: 1,
        year: 1901,
      },
      address: {
        line1: '123 Collins Street',
        city: 'Melbourne',
        state: 'VIC',
        postal_code: '3000',
        country: 'AU',
      },
      id_number: '000000000',
    },
    external_account: {
      object: 'bank_account',
      country: 'AU',
      currency: 'aud',
      account_number: '000123456',
      routing_number: '110000',
    },
    tos_acceptance: {
      date: Math.floor(Date.now() / 1000),
      ip: '127.0.0.1',
    },
  });

  console.log('Account created:', account.id);

  // Step 2: Immediately update to ensure capabilities are active
  await stripe.accounts.update(account.id, {
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  // Step 3: Save the account ID to .env automatically
  const envContent = fs.readFileSync('.env', 'utf8');

  if (envContent.includes('RESTAURANT_CONNECTED_ACCOUNT_ID=')) {
    const updated = envContent.replace(
      /RESTAURANT_CONNECTED_ACCOUNT_ID=.*/,
      'RESTAURANT_CONNECTED_ACCOUNT_ID=' + account.id
    );
    fs.writeFileSync('.env', updated);
  } else {
    fs.appendFileSync(
      '.env',
      '\nRESTAURANT_CONNECTED_ACCOUNT_ID=' + account.id
    );
  }

  // Step 4: Verify the capabilities came through
  const retrieved = await stripe.accounts.retrieve(account.id);

  console.log('');
  console.log('==============================================');
  console.log('FOODNOW CONNECT SETUP COMPLETE');
  console.log('==============================================');
  console.log('Account ID:     ', account.id);
  console.log(
    'Card payments:  ',
    retrieved.capabilities.card_payments
  );
  console.log(
    'Transfers:      ',
    retrieved.capabilities.transfers
  );
  console.log('Charges enabled:', retrieved.charges_enabled);
  console.log('Payouts enabled:', retrieved.payouts_enabled);
  console.log('');
  console.log('Account ID has been written to your .env file');
  console.log('automatically as RESTAURANT_CONNECTED_ACCOUNT_ID');
  console.log('');
  console.log('Next steps:');
  console.log('1. Restart your app: npm start');
  console.log('2. Visit: http://localhost:3000/foodnow');
  console.log('3. Make a test payment with: 4242 4242 4242 4242');
  console.log('4. Check Stripe Dashboard → Payments to see');
  console.log('   the platform fee split automatically');
  console.log('==============================================');
}

setupConnectedAccount().catch(console.error);
