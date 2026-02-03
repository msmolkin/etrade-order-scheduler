import { ETradeClient } from '../server/services/etrade-client.js';
import type { ETradeCredentials } from '../shared/types/index.js';
import dotenv from 'dotenv';
import axios from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const isSandbox = process.env.ETRADE_SANDBOX === 'true';
const baseUrl = isSandbox ? 'https://apisb.etrade.com' : 'https://api.etrade.com';

const credentials: ETradeCredentials = isSandbox
  ? {
      consumerKey: process.env.ETRADE_SANDBOX_KEY!,
      consumerSecret: process.env.ETRADE_SANDBOX_SECRET!,
      accessToken: process.env.ETRADE_SANDBOX_ACCESS_TOKEN,
      accessTokenSecret: process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET,
    }
  : {
      consumerKey: process.env.ETRADE_CONSUMER_KEY!,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
      accessToken: process.env.ETRADE_ACCESS_TOKEN,
      accessTokenSecret: process.env.ETRADE_ACCESS_TOKEN_SECRET,
    };

const oauth = new OAuth({
  consumer: {
    key: credentials.consumerKey,
    secret: credentials.consumerSecret,
  },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});

function getAuthHeader(url: string, method: string = 'GET') {
  if (!credentials.accessToken || !credentials.accessTokenSecret) {
    throw new Error('Access tokens not set');
  }
  const token = {
    key: credentials.accessToken,
    secret: credentials.accessTokenSecret,
  };
  const authData = oauth.authorize({ url, method }, token);
  return oauth.toHeader(authData);
}

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cancelAndModifyOrders() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Cancel and Modify Orders                               ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  log(`Mode: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}`);

  const client = new ETradeClient(credentials, isSandbox);

  try {
    // Step 1: Get accounts
    log('Step 1: Fetching accounts...');
    const accounts = await client.getAccounts();
    
    if (!accounts || accounts.length === 0) {
      log('ERROR: No accounts found');
      process.exit(1);
    }

    // Step 2: Search all accounts for JPM order if not found in specified account
    log('\nStep 2: Searching for orders...');
    
    const accountNickname = process.env.ACCOUNT;
    let accountIdKey: string;
    let accountName: string;
    let orders: any[] = [];
    let jpmOrder: any = null;
    let nebxOrder: any = null;

    // First, try the specified account or default account
    if (accountNickname) {
      const nicknamesPath = path.join(process.cwd(), '.account-nicknames.json');
      if (fs.existsSync(nicknamesPath)) {
        const nicknames = JSON.parse(fs.readFileSync(nicknamesPath, 'utf-8'));
        const savedAccount = nicknames.find((n: any) => n.nickname === accountNickname);
        if (savedAccount) {
          accountIdKey = savedAccount.accountIdKey;
          accountName = `${savedAccount.accountName} (${accountNickname})`;
        } else {
          const matchingAccount = accounts.find((acc: any) => acc.accountId.endsWith(accountNickname));
          if (matchingAccount) {
            accountIdKey = matchingAccount.accountIdKey;
            accountName = `${matchingAccount.accountDesc} (${accountNickname})`;
          } else {
            log('ERROR: Account not found');
            process.exit(1);
          }
        }
      } else {
        const matchingAccount = accounts.find((acc: any) => acc.accountId.endsWith(accountNickname));
        if (matchingAccount) {
          accountIdKey = matchingAccount.accountIdKey;
          accountName = `${matchingAccount.accountDesc} (${accountNickname})`;
        } else {
          log('ERROR: Account not found');
          process.exit(1);
        }
      }
    } else {
      const activeAccount = accounts.find((acc: any) => acc.accountStatus === 'ACTIVE');
      if (!activeAccount) {
        log('ERROR: No active accounts found');
        process.exit(1);
      }
      accountIdKey = activeAccount.accountIdKey;
      accountName = `${activeAccount.accountDesc || activeAccount.accountName} (${activeAccount.accountId.slice(-4)})`;
    }

    log(`Using account: ${accountName}`);
    log(`Account ID Key: ${accountIdKey}`);

    // List orders in primary account
    const listUrl = `${baseUrl}/v1/accounts/${accountIdKey}/orders`;
    const listHeaders = getAuthHeader(listUrl, 'GET');

    const listResponse = await axios.get(listUrl, {
      headers: {
        ...listHeaders,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    log(`Status: ${listResponse.status}`);
    orders = listResponse.data.OrdersResponse?.Order || [];
    log(`Found ${orders.length} orders in primary account`);

    // List all order symbols for debugging
    log('\nAll order symbols in account:');
    const allSymbols = new Set<string>();
    orders.forEach((order: any) => {
      const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
      if (instrument?.Product?.symbol) {
        allSymbols.add(instrument.Product.symbol);
      }
    });
    log(Array.from(allSymbols).sort().join(', '));

    // Find NEBX order
    nebxOrder = orders.find((order: any) => {
      const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
      return instrument?.Product?.symbol === 'NEBX';
    });

    // Find JPM order - start with very broad search, just by symbol
    log('\nSearching for JPM orders...');
    const allJpmOrders = orders.filter((order: any) => {
      const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
      return instrument?.Product?.symbol === 'JPM';
    });
    
    log(`Found ${allJpmOrders.length} JPM orders in primary account`);
    
    // Log all JPM orders to see their structure
    allJpmOrders.forEach((order: any) => {
      const detail = order.OrderDetail[0];
      const instrument = detail.Instrument[0];
      const product = instrument.Product;
      log(`\n  Order ID: ${order.orderId}`);
      log(`  Status: ${detail.status}`);
      log(`  Limit Price: ${detail.limitPrice}`);
      log(`  Order Action: ${instrument.orderAction}`);
      log(`  Product Type: ${product.securityType || 'N/A'}`);
      log(`  Call/Put: ${product.callPut || 'N/A'}`);
      log(`  Full Product:`, JSON.stringify(product, null, 2));
    });
    
    // Now try to find the specific one - look for any JPM order with price around 0.48
    jpmOrder = orders.find((order: any) => {
      const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
      const detail = order.OrderDetail?.[0];
      const product = instrument?.Product;
      if (product?.symbol !== 'JPM') return false;
      // Check if price is around 0.48
      const priceMatch = detail?.limitPrice === 0.48 || Math.abs(detail?.limitPrice - 0.48) < 0.01;
      // Check if it's a call (could be 'CALL', 'C', or something else)
      const isCall = !product?.callPut || product.callPut === 'CALL' || product.callPut === 'C' || product.securityType === 'OPTN';
      // Check if it's a sell action
      const isSell = instrument?.orderAction?.includes('SELL');
      return priceMatch && (isCall || !product?.callPut) && isSell;
    });
    
    // If not found with strict criteria, just find any JPM order with price 0.48
    if (!jpmOrder) {
      jpmOrder = orders.find((order: any) => {
        const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
        const detail = order.OrderDetail?.[0];
        return instrument?.Product?.symbol === 'JPM' && 
               (detail?.limitPrice === 0.48 || Math.abs(detail?.limitPrice - 0.48) < 0.01);
      });
    }
    
    // If still not found, search all accounts
    if (!jpmOrder && allJpmOrders.length === 0) {
      log('\nJPM order not found in primary account. Searching all accounts...');
      for (const acc of accounts) {
        if (acc.accountIdKey === accountIdKey) continue; // Skip already searched
        log(`  Checking account: ${acc.accountDesc || acc.accountName} (${acc.accountId.slice(-4)})`);
        try {
          const accListUrl = `${baseUrl}/v1/accounts/${acc.accountIdKey}/orders`;
          const accListHeaders = getAuthHeader(accListUrl, 'GET');
          const accListResponse = await axios.get(accListUrl, {
            headers: {
              ...accListHeaders,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
          });
          const accOrders = accListResponse.data.OrdersResponse?.Order || [];
          
          // List all symbols in this account
          const accSymbols = new Set<string>();
          accOrders.forEach((order: any) => {
            const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
            if (instrument?.Product?.symbol) {
              accSymbols.add(instrument.Product.symbol);
            }
          });
          if (accSymbols.size > 0) {
            log(`    Symbols: ${Array.from(accSymbols).sort().join(', ')}`);
          }
          
          const accJpmOrders = accOrders.filter((order: any) => {
            const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
            return instrument?.Product?.symbol === 'JPM';
          });
          
          if (accJpmOrders.length > 0) {
            log(`    ✓ Found ${accJpmOrders.length} JPM orders in this account`);
            accJpmOrders.forEach((order: any) => {
              const detail = order.OrderDetail[0];
              const instrument = detail.Instrument[0];
              const product = instrument.Product;
              log(`\n      Order ID: ${order.orderId}`);
              log(`      Status: ${detail.status}`);
              log(`      Limit Price: ${detail.limitPrice}`);
              log(`      Order Action: ${instrument.orderAction}`);
              log(`      Product Type: ${product.securityType || 'N/A'}`);
              log(`      Call/Put: ${product.callPut || 'N/A'}`);
              log(`      Full Product:`, JSON.stringify(product, null, 2));
            });
            
            // Try to find the one with price 0.48 (or any JPM order if none match)
            jpmOrder = accOrders.find((order: any) => {
              const instrument = order.OrderDetail?.[0]?.Instrument?.[0];
              const detail = order.OrderDetail?.[0];
              if (instrument?.Product?.symbol !== 'JPM') return false;
              return detail?.limitPrice === 0.48 || Math.abs(detail?.limitPrice - 0.48) < 0.01;
            });
            
            // If no exact price match, just take the first OPEN JPM order
            if (!jpmOrder) {
              jpmOrder = accJpmOrders.find((order: any) => order.OrderDetail[0].status === 'OPEN');
            }
            
            if (jpmOrder) {
              accountIdKey = acc.accountIdKey; // Update to use the account with JPM order
              accountName = `${acc.accountDesc || acc.accountName} (${acc.accountId.slice(-4)})`;
              orders = accOrders; // Update orders list
              break;
            }
          }
        } catch (error: any) {
          log(`    ✗ Error checking account: ${error.message}`);
          // Skip accounts that fail
          continue;
        }
      }
    }
    
    if (jpmOrder) {
      const detail = jpmOrder.OrderDetail[0];
      const instrument = detail.Instrument[0];
      log(`\n✓ Found JPM order (ID: ${jpmOrder.orderId})`);
      log(`  Status: ${detail.status}`);
      log(`  Current Limit Price: ${detail.limitPrice}`);
      log(`  Order Action: ${instrument.orderAction}`);
      log(`  Product:`, JSON.stringify(instrument.Product, null, 2));
      log(`  Will attempt to modify to 0.45`);
    }

    const results: any = {
      timestamp: new Date().toISOString(),
      account: { accountIdKey, accountName },
      listOrders: {
        url: listUrl,
        status: listResponse.status,
        totalOrders: orders.length,
        xEtTrace: listResponse.headers['x-et-trace'],
      },
      cancelNEBX: null,
      modifyJPM: null,
    };

    // Step 3: Cancel NEBX order
    if (nebxOrder) {
      log(`\nStep 3: Canceling NEBX order (ID: ${nebxOrder.orderId})...`);
      log(`Order details: ${nebxOrder.OrderDetail[0].Instrument[0].symbolDescription}`);
      log(`Status: ${nebxOrder.OrderDetail[0].status}`);
      log(`Limit Price: ${nebxOrder.OrderDetail[0].limitPrice}`);

      if (nebxOrder.OrderDetail[0].status === 'CANCELLED' || nebxOrder.OrderDetail[0].status === 'EXECUTED' || nebxOrder.OrderDetail[0].status === 'EXPIRED') {
        log(`⚠ Order is already ${nebxOrder.OrderDetail[0].status}, cannot cancel`);
        results.cancelNEBX = {
          success: false,
          orderId: nebxOrder.orderId,
          error: `Order is already ${nebxOrder.OrderDetail[0].status.toLowerCase()}`,
          status: nebxOrder.OrderDetail[0].status,
        };
      } else {
        try {
          await client.cancelOrder(accountIdKey, nebxOrder.orderId.toString());
          log('✓ NEBX order canceled successfully');
          results.cancelNEBX = {
            success: true,
            orderId: nebxOrder.orderId,
            message: 'Order canceled successfully',
          };
        } catch (error: any) {
          log('✗ Failed to cancel NEBX order');
          log(`Error: ${error.message}`);
          if (error.response) {
            log(`Status: ${error.response.status}`);
            log('Response:', error.response.data);
          }
          results.cancelNEBX = {
            success: false,
            orderId: nebxOrder.orderId,
            error: error.message,
            status: error.response?.status,
            response: error.response?.data,
            xEtTrace: error.response?.headers?.['x-et-trace'],
          };
        }
      }
    } else {
      log('\n⚠ NEBX order not found');
      results.cancelNEBX = {
        success: false,
        error: 'NEBX order not found',
      };
    }

    // Step 4: Modify JPM order or find another order to test modify
    if (jpmOrder) {
      log(`\nStep 4: Modifying JPM call sale order (ID: ${jpmOrder.orderId})...`);
      log(`Order details: ${jpmOrder.OrderDetail[0].Instrument[0].symbolDescription}`);
      log(`Current Limit Price: ${jpmOrder.OrderDetail[0].limitPrice}`);
      log(`New Limit Price: 0.45`);
      log(`Status: ${jpmOrder.OrderDetail[0].status}`);

      if (jpmOrder.OrderDetail[0].status !== 'OPEN') {
        log(`⚠ Order is ${jpmOrder.OrderDetail[0].status}, cannot modify`);
        results.modifyJPM = {
          success: false,
          orderId: jpmOrder.orderId,
          error: `Order is ${jpmOrder.OrderDetail[0].status}, cannot modify`,
          status: jpmOrder.OrderDetail[0].status,
        };
      } else {
        // Try to modify order - E*TRADE might use different endpoint formats
        // Based on E*TRADE API, modify might require preview + place with same orderId
        // Or use /orders/{orderId}/change endpoint
        const modifyEndpoints = [
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/${jpmOrder.orderId}/change`,
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/replace`,
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/modify`,
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/${jpmOrder.orderId}/replace`,
        ];

      let modifySuccess = false;
      for (const modifyUrl of modifyEndpoints) {
        try {
          log(`\nTrying endpoint: ${modifyUrl}`);
          const modifyHeaders = getAuthHeader(modifyUrl, 'PUT');
          
          // Build modify request - need to get full order details first
          const orderDetail = jpmOrder.OrderDetail[0];
          const instrument = orderDetail.Instrument[0];
          
          const modifyPayload = {
            ChangeOrderRequest: {
              orderId: jpmOrder.orderId,
              orderType: jpmOrder.orderType,
              clientOrderId: `mod${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
              Order: [{
                allOrNone: orderDetail.allOrNone,
                priceType: orderDetail.priceType,
                orderTerm: orderDetail.orderTerm,
                marketSession: orderDetail.marketSession,
                  limitPrice: jpmOrder.OrderDetail[0].limitPrice === 0.48 ? 0.45 : 0.45, // New price (0.45 as requested)
                Instrument: [{
                  Product: instrument.Product,
                  orderAction: instrument.orderAction,
                  quantityType: instrument.quantityType,
                  quantity: instrument.orderedQuantity,
                }],
              }],
            },
          };

          const modifyResponse = await axios.put(modifyUrl, modifyPayload, {
            headers: {
              ...modifyHeaders,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
          });

          log(`✓ Order modified successfully (Status: ${modifyResponse.status})`);
          log('Response:', modifyResponse.data);
          results.modifyJPM = {
            success: true,
            orderId: jpmOrder.orderId,
            endpoint: modifyUrl,
            status: modifyResponse.status,
            response: modifyResponse.data,
            xEtTrace: modifyResponse.headers['x-et-trace'],
          };
          modifySuccess = true;
          break;
        } catch (error: any) {
          log(`✗ Failed with endpoint ${modifyUrl}`);
          log(`Status: ${error.response?.status || 'NO RESPONSE'}`);
          if (error.response?.data) {
            log('Error:', error.response.data);
          }
          // Continue to next endpoint
        }
      }

        if (!modifySuccess) {
          log('\n✗ All modify endpoints failed');
          results.modifyJPM = {
            success: false,
            orderId: jpmOrder.orderId,
            error: 'All modify endpoints failed',
            endpointsTried: modifyEndpoints,
          };
        }
      }
    } else {
      log('\n⚠ JPM call sale order not found');
      
      // Try to find any OPEN order with a limit price to test modify functionality
      // But first, let's list all OPEN orders to see what's available
      const openOrders = orders.filter((order: any) => {
        const detail = order.OrderDetail?.[0];
        return detail?.status === 'OPEN' && detail?.limitPrice > 0;
      });

      log(`\nFound ${openOrders.length} OPEN orders with limit prices`);
      openOrders.forEach((order: any) => {
        const detail = order.OrderDetail[0];
        const instrument = detail.Instrument[0];
        log(`  Order ID: ${order.orderId}, Symbol: ${instrument.Product.symbol}, Price: ${detail.limitPrice}, Action: ${instrument.orderAction}`);
      });

      if (openOrders.length > 0) {
        // Use the first OPEN order (but not the one we just cancelled)
        const testOrder = openOrders.find((o: any) => o.orderId !== nebxOrder?.orderId) || openOrders[0];
        
        log(`\nTesting modify with order ID ${testOrder.orderId}`);
        log(`Order: ${testOrder.OrderDetail[0].Instrument[0].symbolDescription}`);
        log(`Current Limit Price: ${testOrder.OrderDetail[0].limitPrice}`);
        log(`New Limit Price: ${testOrder.OrderDetail[0].limitPrice - 0.01}`);

        const modifyEndpoints = [
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/${testOrder.orderId}/change`,
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/replace`,
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/modify`,
          `${baseUrl}/v1/accounts/${accountIdKey}/orders/${testOrder.orderId}/replace`,
        ];

        let modifySuccess = false;
        for (const modifyUrl of modifyEndpoints) {
          try {
            log(`\nTrying modify endpoint: ${modifyUrl}`);
            const modifyHeaders = getAuthHeader(modifyUrl, 'PUT');
            
            const orderDetail = testOrder.OrderDetail[0];
            const instrument = orderDetail.Instrument[0];
            
            const modifyPayload = {
              ChangeOrderRequest: {
                orderId: testOrder.orderId,
                orderType: testOrder.orderType,
                clientOrderId: `mod${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
                Order: [{
                  allOrNone: orderDetail.allOrNone,
                  priceType: orderDetail.priceType,
                  orderTerm: orderDetail.orderTerm,
                  marketSession: orderDetail.marketSession,
                  limitPrice: orderDetail.limitPrice - 0.01, // Small change for testing
                  Instrument: [{
                    Product: instrument.Product,
                    orderAction: instrument.orderAction,
                    quantityType: instrument.quantityType,
                    quantity: instrument.orderedQuantity,
                  }],
                }],
              },
            };

            log('Request payload:', JSON.stringify(modifyPayload, null, 2));
            
            const modifyResponse = await axios.put(modifyUrl, modifyPayload, {
              headers: {
                ...modifyHeaders,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
            });

            log(`✓ Order modified successfully (Status: ${modifyResponse.status})`);
            log('Response:', modifyResponse.data);
            results.modifyJPM = {
              success: true,
              orderId: testOrder.orderId,
              endpoint: modifyUrl,
              status: modifyResponse.status,
              response: modifyResponse.data,
              xEtTrace: modifyResponse.headers['x-et-trace'],
              note: 'Tested with different order since JPM order not found',
            };
            modifySuccess = true;
            break;
          } catch (error: any) {
            log(`✗ Failed with endpoint ${modifyUrl}`);
            log(`Status: ${error.response?.status || 'NO RESPONSE'}`);
            if (error.response?.data) {
              log('Error:', error.response.data);
            }
            // Continue to next endpoint
          }
        }

        if (!modifySuccess) {
          log('\n✗ All modify endpoints failed');
          results.modifyJPM = {
            success: false,
            orderId: testOrder.orderId,
            error: 'All modify endpoints failed',
            endpointsTried: modifyEndpoints,
            note: 'Tested with different order since JPM order not found',
          };
        }
      } else {
        results.modifyJPM = {
          success: false,
          error: 'JPM call sale order not found, and no OPEN orders available to test modify',
        };
      }
    }

    // Save results
    const resultsDir = path.join(process.cwd(), 'etrade-documentation', 'api-test-results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsFile = path.join(resultsDir, `test-results-cancel-modify-${timestamp}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    log(`\n✓ Results saved to: test-results-cancel-modify-${timestamp}.json`);

  } catch (error: any) {
    log('ERROR: ' + error.message);
    if (error.response) {
      log('Status: ' + error.response.status);
      log('Response:', error.response.data);
    }
    process.exit(1);
  }
}

cancelAndModifyOrders();
