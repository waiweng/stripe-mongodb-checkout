/**
 * FoodNow Plus subscription — creates an incomplete Stripe Billing subscription on the server,
 * mounts the Payment Element for the first invoice’s PaymentIntent, then confirms and redirects
 * to /foodnow/subscription-confirmation.
 *
 * Loaded in <head>; we wait for DOMContentLoaded before touching the DOM.
 */
function initFoodnowSubscribePage() {
  var configEl = document.getElementById('foodnow-subscribe-config');
  if (!configEl) {
    return;
  }

  var publishableKey = configEl.getAttribute('data-publishable-key');

  var btnPrepare = document.getElementById('foodnow-sub-btn-prepare');
  var btnSubmit = document.getElementById('foodnow-sub-btn-submit');
  var stepDetails = document.getElementById('foodnow-subscribe-step-details');
  var stepPay = document.getElementById('foodnow-subscribe-step-pay');

  if (!btnPrepare || !btnSubmit || !stepDetails || !stepPay) {
    console.error('FoodNow subscribe page is missing expected buttons or sections.');
    return;
  }

  var stripe = null;
  var elements = null;
  var subscriptionIdFromServer = null;

  btnPrepare.addEventListener('click', async function onFoodnowSubscribePrepareClick() {
    var nameInput = document.getElementById('foodnowSubCustomerName');
    var emailInput = document.getElementById('foodnowSubCustomerEmail');
    var customerName = nameInput.value.trim();
    var customerEmail = emailInput.value.trim();

    if (!customerName || !customerEmail) {
      window.alert('Please enter your name and email.');
      return;
    }

    if (!publishableKey) {
      window.alert('Stripe publishable key is missing. Add STRIPE_PUBLISHABLE_KEY to your .env file and restart the server.');
      return;
    }

    btnPrepare.disabled = true;

    try {
      // Server creates a Subscription with default_incomplete and returns the first invoice PaymentIntent client secret.
      var response = await fetch('/foodnow/create-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customerName: customerName,
          customerEmail: customerEmail,
        }),
      });

      var payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Could not start subscription.');
      }

      subscriptionIdFromServer = payload.subscriptionId;

      if (!subscriptionIdFromServer) {
        throw new Error('Server did not return a subscription id.');
      }

      stripe = window.Stripe(publishableKey);
      elements = stripe.elements({
        clientSecret: payload.clientSecret,
      });

      var paymentElement = elements.create('payment');
      paymentElement.mount('#foodnow-subscribe-payment-element');

      stepDetails.classList.add('d-none');
      stepPay.classList.remove('d-none');
    } catch (error) {
      console.error(error);
      window.alert(error.message || 'Something went wrong. Please try again.');
      btnPrepare.disabled = false;
    }
  });

  btnSubmit.addEventListener('click', async function onFoodnowSubscribeSubmitClick() {
    if (!subscriptionIdFromServer) {
      window.alert('Please continue from “Your details” first so we can start the subscription.');
      return;
    }

    btnSubmit.disabled = true;

    // Stripe replaces {PAYMENT_INTENT_ID} after pay; we attach subscription_id so the confirmation page can load the Subscription under Basil (PI.invoice may be absent).
    var baseUrl = window.location.protocol + '//' + window.location.host;
    var returnUrl =
      baseUrl +
      '/foodnow/subscription-confirmation?payment_intent={PAYMENT_INTENT_ID}&subscription_id=' +
      encodeURIComponent(subscriptionIdFromServer);

    var result = await stripe.confirmPayment({
      elements: elements,
      confirmParams: {
        return_url: returnUrl,
      },
    });

    if (result.error) {
      window.alert(result.error.message);
      btnSubmit.disabled = false;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFoodnowSubscribePage);
} else {
  initFoodnowSubscribePage();
}
