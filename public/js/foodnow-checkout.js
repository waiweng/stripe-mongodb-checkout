/**
 * FoodNow order checkout — requests a Connect PaymentIntent from the server, mounts the Payment Element,
 * then confirms payment and redirects to /foodnow/confirmation with the PaymentIntent id in the query string.
 *
 * Loaded in <head>; we wait for DOMContentLoaded before touching the DOM.
 */
function initFoodnowCheckoutPage() {
  var configEl = document.getElementById('foodnow-checkout-config');
  if (!configEl) {
    return;
  }

  var publishableKey = configEl.getAttribute('data-publishable-key');
  var returnUrl = configEl.getAttribute('data-return-url');
  var menuItemId = configEl.getAttribute('data-menu-item-id');

  var btnPrepare = document.getElementById('foodnow-btn-prepare');
  var btnSubmit = document.getElementById('foodnow-btn-submit');
  var stepDetails = document.getElementById('foodnow-step-details');
  var stepPay = document.getElementById('foodnow-step-pay');

  if (!btnPrepare || !btnSubmit || !stepDetails || !stepPay) {
    console.error('FoodNow checkout page is missing expected buttons or sections.');
    return;
  }

  var stripe = null;
  var elements = null;

  btnPrepare.addEventListener('click', async function onFoodnowPrepareClick() {
    var nameInput = document.getElementById('foodnowCustomerName');
    var emailInput = document.getElementById('foodnowCustomerEmail');
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
      // Ask the platform server to create a destination-charge PaymentIntent and return the client secret for Elements.
      var response = await fetch('/foodnow/create-payment-intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          menuItemId: menuItemId,
          customerName: customerName,
          customerEmail: customerEmail,
        }),
      });

      var payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Could not start payment.');
      }

      stripe = window.Stripe(publishableKey);
      elements = stripe.elements({
        clientSecret: payload.clientSecret,
      });

      var paymentElement = elements.create('payment');
      paymentElement.mount('#foodnow-payment-element');

      stepDetails.classList.add('d-none');
      stepPay.classList.remove('d-none');
    } catch (error) {
      console.error(error);
      window.alert(error.message || 'Something went wrong. Please try again.');
      btnPrepare.disabled = false;
    }
  });

  btnSubmit.addEventListener('click', async function onFoodnowSubmitClick() {
    btnSubmit.disabled = true;

    // confirmPayment completes 3DS if required, then redirects to returnUrl with payment_intent in the query string.
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
  document.addEventListener('DOMContentLoaded', initFoodnowCheckoutPage);
} else {
  initFoodnowCheckoutPage();
}
