/**
 * Checkout page: requests a PaymentIntent from our server, mounts the Stripe Payment Element,
 * then confirms the payment and sends the browser to the confirmation URL Stripe provides.
 *
 * This file is loaded in <head>, so we wait for DOMContentLoaded before querying elements.
 */
function initCheckoutPage() {
  var configEl = document.getElementById('checkout-config');
  if (!configEl) {
    return;
  }

  var publishableKey = configEl.getAttribute('data-publishable-key');
  var returnUrl = configEl.getAttribute('data-return-url');
  var productId = configEl.getAttribute('data-product-id');

  var btnPrepare = document.getElementById('btn-prepare-payment');
  var btnSubmit = document.getElementById('btn-submit-payment');
  var stepDetails = document.getElementById('checkout-step-details');
  var stepPay = document.getElementById('checkout-step-pay');

  if (!btnPrepare || !btnSubmit || !stepDetails || !stepPay) {
    console.error('Checkout page is missing expected buttons or sections.');
    return;
  }

  var stripe = null;
  var elements = null;

  btnPrepare.addEventListener('click', async function onPrepareClick() {
    var nameInput = document.getElementById('customerName');
    var emailInput = document.getElementById('customerEmail');
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
      var response = await fetch('/create-payment-intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: productId,
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
      paymentElement.mount('#payment-element');

      stepDetails.classList.add('d-none');
      stepPay.classList.remove('d-none');
    } catch (error) {
      console.error(error);
      window.alert(error.message || 'Something went wrong. Please try again.');
      btnPrepare.disabled = false;
    }
  });

  btnSubmit.addEventListener('click', async function onSubmitClick() {
    btnSubmit.disabled = true;

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
  document.addEventListener('DOMContentLoaded', initCheckoutPage);
} else {
  initCheckoutPage();
}
