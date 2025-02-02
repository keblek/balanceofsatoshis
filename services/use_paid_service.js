const asyncAuto = require('async/auto');
const {confirmServiceUse} = require('paid-services');
const {getServicesList} = require('paid-services');
const {getServiceSchema} = require('paid-services');
const {makeServiceRequest} = require('paid-services');
const {parsePaymentRequest} = require('ln-service');
const {pay} = require('ln-service');
const {returnResult} = require('asyncjs-util');

const bigUnit = tokens => displayTokens({tokens, is_monochrome: true}).display;
const byName = (a, b) => a.name < b.name ? -1 : 1;
const defaultMaxFee = 1337;
const isPublicKey = n => !!n && /^[0-9A-F]{66}$/i.test(n);
const {keys} = Object;

/** Use a paid service

  {
    ask: <Inquirer Ask Function>
    lnd: <Authenticated LND API Object>
    logger: <Winston Logger Object>
    network: <Network Name String>
    node: <Node Public Key Hex String>
  }
*/
module.exports = ({ask, lnd, logger, network, node}, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!ask) {
          return cbk([400, 'ExpectedAskFunctionToUsePaidService']);
        }

        if (!lnd) {
          return cbk([400, 'ExpectedLndToUsePaidService']);
        }

        if (!logger) {
          return cbk([400, 'ExpectedWinstonLoggerToUsePaidService']);
        }

        if (!network) {
          return cbk([400, 'ExpectedNetworkNameToUsePaidService']);
        }

        if (!isPublicKey(node)) {
          return cbk([400, 'ExpectedNodePublicKeyToUsePaidService']);
        }

        return cbk();
      },

      // Get the services list for the specified node
      getServices: ['validate', ({}, cbk) => {
        return getServicesList({lnd, network, node}, cbk);
      }],

      // Select a service from the available services
      chooseService: ['getServices', ({getServices}, cbk) => {
        return ask([{
          choices: getServices.services.slice().sort(byName).map(n => n.name),
          type: 'list',
          name: 'name',
          message: 'Choose service:',
        }],
        res => cbk(null, res));
      }],

      // Get service details for the selected service
      getService: ['chooseService', ({chooseService}, cbk) => {
        return getServiceSchema({
          lnd,
          network,
          node,
          named: chooseService.name,
        },
        cbk);
      }],

      // Confirm the use of the service and fill in any required arguments
      confirmService: ['getService', ({getService}, cbk) => {
        return confirmServiceUse({
          ask,
          description: getService.description,
          fields: getService.fields,
        },
        cbk);
      }],

      // Send the service request
      sendRequest: [
        'confirmService',
        'getService',
        ({confirmService, getService}, cbk) =>
      {
        return makeServiceRequest({
          lnd,
          network,
          node,
          arguments: confirmService.arguments,
          id: getService.id,
        },
        cbk);
      }],

      // Log the raw result of the service request
      result: ['sendRequest', ({sendRequest}, cbk) => {
        // Remove undefined attributes from the response
        const response = keys(sendRequest).reduce((sum, key) => {
          if (sendRequest[key] !== undefined) {
            sum[key] = sendRequest[key];
          }

          return sum;
        },
        {});

        logger.info({service_response: response});

        return cbk(null, response);
      }],

      // Confirm payment of a paywall
      confirmPayment: ['result', ({result}, cbk) => {
        // Exit early when there is no paywall to confirm
        if (!result.paywall) {
          return cbk();
        }

        const {tokens} = parsePaymentRequest({request: result.paywall});

        return ask([{
          type: 'confirm',
          name: 'confirm',
          message: result.text || 'Confirm?',
          prefix: `[Pay ${bigUnit(tokens)}]`,
        }],
        res => cbk(null, res));
      }],

      // Send the paywall payment
      pay: ['confirmPayment', 'result', ({confirmPayment, result}, cbk) => {
        // Exit early when there is no paywall
        if (!result.paywall) {
          return cbk();
        }

        // Exit early when not wanting to pay a paywall
        if (!confirmPayment.confirm) {
          return cbk();
        }

        return pay({
          lnd,
          max_fee: defaultMaxFee,
          request: result.paywall,
        },
        cbk);
      }],

      // Final payment total
      paidTotal: ['pay', ({pay}, cbk) => {
        // Exit early when there was no paywall paid
        if (!pay) {
          return cbk();
        }

        logger.info({success: {paid: bigUnit(pay.tokens)}});

        return cbk();
      }],
    },
    returnResult({reject, resolve}, cbk));
  });
};
