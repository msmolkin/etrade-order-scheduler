import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import type {
  ETradeCredentials,
  ETradeAccount,
  ETradeOrderRequest,
  ETradeOrderResponse,
  ETradeQuote,
  OptionsChain,
} from '../../shared/types/index.js';

export class ETradeClient {
  private oauth: OAuth;
  private credentials: ETradeCredentials;
  private baseUrl: string;
  private httpClient: AxiosInstance;

  constructor(credentials: ETradeCredentials, sandbox: boolean = false) {
    this.credentials = credentials;
    this.baseUrl = sandbox
      ? 'https://apisb.etrade.com'
      : 'https://api.etrade.com';

    this.oauth = new OAuth({
      consumer: {
        key: credentials.consumerKey,
        secret: credentials.consumerSecret,
      },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string, key) {
        return crypto.createHmac('sha1', key).update(base_string).digest('base64');
      },
    });

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    // Log requests for debugging
    this.httpClient.interceptors.request.use((config) => {
      console.log('Axios request:', config.method?.toUpperCase(), config.baseURL + config.url);
      return config;
    });
  }

  private getAuthHeader(url: string, method: string = 'GET') {
    if (!this.credentials.accessToken || !this.credentials.accessTokenSecret) {
      throw new Error('Access tokens not set. Please authenticate first.');
    }

    const token = {
      key: this.credentials.accessToken,
      secret: this.credentials.accessTokenSecret,
    };

    const authData = this.oauth.authorize({ url, method }, token);
    return this.oauth.toHeader(authData);
  }

  async getAccounts(): Promise<ETradeAccount[]> {
    const url = `${this.baseUrl}/v1/accounts/list`;
    const headers = this.getAuthHeader(url);

    const response = await this.httpClient.get('/v1/accounts/list', { headers });
    return response.data.AccountListResponse.Accounts.Account;
  }

  async placeOrder(request: ETradeOrderRequest): Promise<ETradeOrderResponse> {
    // Step 1: Preview the order
    const previewUrl = `${this.baseUrl}/v1/accounts/${request.accountIdKey}/orders/preview`;
    console.log('Calling preview URL:', previewUrl);
    const previewHeaders = this.getAuthHeader(previewUrl, 'POST');

    // Build order details, only including optional price fields when they have values
    const securityType = request.securityType || 'EQ'; // Default to EQ for backward compatibility
    // E*TRADE doc: OPTN Product = symbol + callPut + expiry (int) + strikePrice; or productId (osiKey from option chain).
    // When productId is provided (from Get Option Chains osiKey), use it per Product definition.
    const optnProduct: Record<string, any> =
      securityType === 'OPTN'
        ? {
            securityType: 'OPTN',
            symbol: request.symbol,
            ...(request.productId && { productId: request.productId }),
            ...(request.callPut && { callPut: request.callPut }),
            ...(request.expiryYear != null && {
              expiryYear: request.expiryYear,
              expiryMonth: request.expiryMonth,
              expiryDay: request.expiryDay,
              ...(request.strikePrice != null && { strikePrice: request.strikePrice }),
            }),
          }
        : { securityType, symbol: request.symbol };
    const orderDetails: Record<string, any> = {
      allOrNone: request.allOrNone || false,
      priceType: request.priceType,
      orderTerm: request.orderTerm,
      marketSession: request.marketSession,
      Instrument: [
        {
          Product: optnProduct,
          orderAction: request.orderAction,
          quantityType: 'QUANTITY',
          quantity: request.quantity,
        },
      ],
    };

    // Only include price fields if they have values (E*TRADE API is sensitive to undefined/null values)
    if (request.limitPrice !== undefined && request.limitPrice !== null) {
      orderDetails.limitPrice = request.limitPrice;
    }
    if (request.stopPrice !== undefined && request.stopPrice !== null) {
      orderDetails.stopPrice = request.stopPrice;
    }

    const orderPayload = {
      orderType: securityType,
      clientOrderId: request.clientOrderId,
      Order: [orderDetails],
    };

    let previewResponse;
    try {
      const requestBody = { PreviewOrderRequest: orderPayload };
      console.log('\n┌─────────────────────────────────────────────────────────────┐');
      console.log('│  ORDER PREVIEW REQUEST                                      │');
      console.log('└─────────────────────────────────────────────────────────────┘');
      console.log('1) API URL:');
      console.log(`   ${previewUrl}`);
      console.log('\n2) Request Headers:');
      console.log(JSON.stringify(previewHeaders, null, 2));
      console.log('\n3) Request Body:');
      console.log(JSON.stringify(requestBody, null, 2));
      
      previewResponse = await this.httpClient.post(
        `/v1/accounts/${request.accountIdKey}/orders/preview`,
        requestBody,
        { headers: previewHeaders }
      );
      
      console.log('\n┌─────────────────────────────────────────────────────────────┐');
      console.log('│  ORDER PREVIEW RESPONSE                                     │');
      console.log('└─────────────────────────────────────────────────────────────┘');
      console.log('4) Response Headers:');
      const responseHeaders = previewResponse.headers || {};
      console.log(JSON.stringify(responseHeaders, null, 2));
      if (responseHeaders['x-et-trace']) {
        console.log(`\nX-ET-Trace: ${responseHeaders['x-et-trace']}`);
      }
      console.log('\n5) Response Body:');
      console.log(JSON.stringify(previewResponse.data, null, 2));
    } catch (error: any) {
      console.log('\n┌─────────────────────────────────────────────────────────────┐');
      console.log('│  ORDER PREVIEW ERROR                                        │');
      console.log('└─────────────────────────────────────────────────────────────┘');
      console.log('1) API URL:');
      console.log(`   ${previewUrl}`);
      console.log('\n2) Request Headers:');
      console.log(JSON.stringify(previewHeaders, null, 2));
      console.log('\n3) Request Body:');
      console.log(JSON.stringify({ PreviewOrderRequest: orderPayload }, null, 2));
      
      if (error.response) {
        console.log('\n4) Response Status:', error.response.status);
        console.log('5) Response Headers:');
        const errorResponseHeaders = error.response.headers || {};
        console.log(JSON.stringify(errorResponseHeaders, null, 2));
        if (errorResponseHeaders['x-et-trace']) {
          console.log(`\nX-ET-Trace: ${errorResponseHeaders['x-et-trace']}`);
        }
        console.log('\n6) Response Body:');
        console.log(JSON.stringify(error.response.data, null, 2));
      } else {
        console.log('\n4) Error (no response):', error.message);
      }
      throw error;
    }

    const previewId = previewResponse.data.PreviewOrderResponse.PreviewIds[0].previewId;
    console.log(`✓ Order preview successful, previewId: ${previewId}`);

    // Step 2: Place the order with previewId
    const placeUrl = `${this.baseUrl}/v1/accounts/${request.accountIdKey}/orders/place`;
    const placeHeaders = this.getAuthHeader(placeUrl, 'POST');

    const placePayload = {
      PlaceOrderRequest: {
        ...orderPayload,
        PreviewIds: [{ previewId }],
      },
    };

    let placeResponse;
    try {
      console.log('Place payload:', JSON.stringify(placePayload, null, 2));
      placeResponse = await this.httpClient.post(
        `/v1/accounts/${request.accountIdKey}/orders/place`,
        placePayload,
        { headers: placeHeaders }
      );
    } catch (error: any) {
      console.error('Place error:', error.response?.status);
      console.error('Place error data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Place error message:', error.message);
      throw error;
    }

    return placeResponse.data.PlaceOrderResponse;
  }

  /**
   * Attempts to place an order directly without preview (experimental).
   * E*TRADE API typically requires preview first, but this method tests if direct placement works.
   */
  async placeOrderDirect(request: ETradeOrderRequest): Promise<ETradeOrderResponse> {
    const placeUrl = `${this.baseUrl}/v1/accounts/${request.accountIdKey}/orders/place`;
    const placeHeaders = this.getAuthHeader(placeUrl, 'POST');

    const securityType = request.securityType || 'EQ';
    const orderDetails: Record<string, any> = {
      allOrNone: request.allOrNone || false,
      priceType: request.priceType,
      orderTerm: request.orderTerm,
      marketSession: request.marketSession,
      Instrument: [
        {
          Product: {
            securityType: securityType,
            symbol: request.symbol,
            ...(securityType === 'OPTN' && request.callPut && { callPut: request.callPut }),
            ...(securityType === 'OPTN' && request.expiryYear != null && {
              expiryYear: request.expiryYear,
              expiryMonth: request.expiryMonth,
              expiryDay: request.expiryDay,
              strikePrice: request.strikePrice,
            }),
          },
          orderAction: request.orderAction,
          quantityType: 'QUANTITY',
          quantity: request.quantity,
        },
      ],
    };

    if (request.limitPrice !== undefined && request.limitPrice !== null) {
      orderDetails.limitPrice = request.limitPrice;
    }
    if (request.stopPrice !== undefined && request.stopPrice !== null) {
      orderDetails.stopPrice = request.stopPrice;
    }

    const placePayload = {
      PlaceOrderRequest: {
        orderType: securityType,
        clientOrderId: request.clientOrderId,
        Order: [orderDetails],
        // Try without PreviewIds to see if it works
      },
    };

    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  DIRECT ORDER PLACEMENT (NO PREVIEW)                        │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('1) API URL:');
    console.log(`   ${placeUrl}`);
    console.log('\n2) Request Headers:');
    console.log(JSON.stringify(placeHeaders, null, 2));
    console.log('\n3) Request Body:');
    console.log(JSON.stringify(placePayload, null, 2));

    try {
      const placeResponse = await this.httpClient.post(
        `/v1/accounts/${request.accountIdKey}/orders/place`,
        placePayload,
        { headers: placeHeaders }
      );

      console.log('\n┌─────────────────────────────────────────────────────────────┐');
      console.log('│  DIRECT ORDER PLACEMENT RESPONSE                           │');
      console.log('└─────────────────────────────────────────────────────────────┘');
      console.log('4) Response Headers:');
      const responseHeaders = placeResponse.headers || {};
      console.log(JSON.stringify(responseHeaders, null, 2));
      if (responseHeaders['x-et-trace']) {
        console.log(`\nX-ET-Trace: ${responseHeaders['x-et-trace']}`);
      }
      console.log('\n5) Response Body:');
      console.log(JSON.stringify(placeResponse.data, null, 2));

      return placeResponse.data.PlaceOrderResponse;
    } catch (error: any) {
      console.log('\n┌─────────────────────────────────────────────────────────────┐');
      console.log('│  DIRECT ORDER PLACEMENT ERROR                              │');
      console.log('└─────────────────────────────────────────────────────────────┘');
      
      if (error.response) {
        console.log('4) Response Status:', error.response.status);
        console.log('5) Response Headers:');
        const errorResponseHeaders = error.response.headers || {};
        console.log(JSON.stringify(errorResponseHeaders, null, 2));
        if (errorResponseHeaders['x-et-trace']) {
          console.log(`\nX-ET-Trace: ${errorResponseHeaders['x-et-trace']}`);
        }
        console.log('\n6) Response Body:');
        console.log(JSON.stringify(error.response.data, null, 2));
      } else {
        console.log('4) Error (no response):', error.message);
      }
      throw error;
    }
  }

  async getOrderStatus(accountIdKey: string, orderId: string): Promise<ETradeOrderResponse> {
    const url = `${this.baseUrl}/v1/accounts/${accountIdKey}/orders/${orderId}`;
    const headers = this.getAuthHeader(url);

    const response = await this.httpClient.get(
      `/v1/accounts/${accountIdKey}/orders/${orderId}`,
      { headers }
    );

    return response.data.OrdersResponse.Order[0];
  }

  async cancelOrder(accountIdKey: string, orderId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/accounts/${accountIdKey}/orders/cancel`;
    const headers = this.getAuthHeader(url, 'PUT');

    await this.httpClient.put(
      `/v1/accounts/${accountIdKey}/orders/cancel`,
      { CancelOrderRequest: { orderId } },
      { headers }
    );
  }

  async getQuote(symbols: string[]): Promise<ETradeQuote[]> {
    const url = `${this.baseUrl}/v1/market/quote/${symbols.join(',')}`;
    const headers = this.getAuthHeader(url);

    const response = await this.httpClient.get(`/v1/market/quote/${symbols.join(',')}`, {
      headers,
    });

    return response.data.QuoteResponse.QuoteData;
  }

  async getOptionsChain(
    symbol: string,
    expirationDate?: string
  ): Promise<OptionsChain> {
    let url = `${this.baseUrl}/v1/market/optionchains?symbol=${symbol}`;
    if (expirationDate) {
      url += `&expiryDate=${expirationDate}`;
    }

    const headers = this.getAuthHeader(url);
    const response = await this.httpClient.get(url.replace(this.baseUrl, ''), { headers });

    const chainData = response.data.OptionChainResponse;

    // Transform E*TRADE response to our format
    return {
      symbol,
      underlyingPrice: chainData.SelectedED?.UnderlyingPrice || 0,
      expirationDates: chainData.ExpirationDate || [],
      strikes: chainData.OptionPair?.map((pair: any) => pair.Call?.strikePrice || pair.Put?.strikePrice) || [],
      calls: chainData.OptionPair?.map((pair: any) => this.transformOptionContract(pair.Call, 'CALL')).filter(Boolean) || [],
      puts: chainData.OptionPair?.map((pair: any) => this.transformOptionContract(pair.Put, 'PUT')).filter(Boolean) || [],
    };
  }

  /**
   * Get valid option expiry dates for a symbol (per E*TRADE Market API).
   * Returns array of { year, month, day } sorted by date.
   */
  async getOptionExpireDates(symbol: string): Promise<{ year: number; month: number; day: number }[]> {
    const url = `${this.baseUrl}/v1/market/optionexpiredate?symbol=${symbol}`;
    const headers = this.getAuthHeader(url);
    const response = await this.httpClient.get(url.replace(this.baseUrl, ''), { headers });
    const data = response.data?.OptionExpireDateResponse || response.data?.optionExpireDateResponse;
    const dates = data?.ExpirationDate ?? data?.expirationDates ?? [];
    const list = Array.isArray(dates) ? dates : [dates];
    return list
      .map((d: any) => ({
        year: Number(d.year ?? d.Year),
        month: Number(d.month ?? d.Month),
        day: Number(d.day ?? d.Day),
      }))
      .filter((d: any) => !isNaN(d.year) && !isNaN(d.month) && !isNaN(d.day))
      .sort((a: any, b: any) => {
        const da = new Date(a.year, a.month - 1, a.day).getTime();
        const db = new Date(b.year, b.month - 1, b.day).getTime();
        return da - db;
      });
  }

  /**
   * Fetch option chain for a specific expiry and strike (per E*TRADE Market API).
   * Returns the osiKey for the call/put at the given strike, or null if not found.
   * Use getOptionExpireDates() to get valid expiry dates first.
   */
  async getOptionOsiKey(
    symbol: string,
    expiryYear: number,
    expiryMonth: number,
    expiryDay: number,
    callPut: 'CALL' | 'PUT',
    strikePrice: number
  ): Promise<string | null> {
    const monthStr = String(expiryMonth).padStart(2, '0');
    const url = `${this.baseUrl}/v1/market/optionchains?symbol=${symbol}&expiryYear=${expiryYear}&expiryMonth=${monthStr}&expiryDay=${expiryDay}&strikePriceNear=${strikePrice}&noOfStrikes=3`;
    const headers = this.getAuthHeader(url);
    const response = await this.httpClient.get(url.replace(this.baseUrl, ''), { headers });
    const chain = response.data?.OptionChainResponse || response.data?.optionChainResponse;
    const pairs = chain?.OptionPair || chain?.optionPairs || [];
    for (const pair of pairs) {
      const leg = callPut === 'CALL' ? (pair.Call || pair.call) : (pair.Put || pair.put);
      if (!leg) continue;
      const strike = leg.strikePrice ?? leg.StrikePrice;
      if (strike != null && Math.round(Number(strike)) === Math.round(strikePrice)) {
        const osiKey = leg.osiKey ?? leg.OsiKey;
        if (osiKey) return osiKey;
      }
    }
    return null;
  }

  private transformOptionContract(contract: any, type: 'CALL' | 'PUT'): any {
    if (!contract) return null;

    return {
      symbol: contract.optionSymbol || '',
      optionType: type,
      strikePrice: contract.strikePrice || 0,
      expirationDate: contract.expirationDate || '',
      bid: contract.bid || 0,
      ask: contract.ask || 0,
      last: contract.lastPrice || 0,
      volume: contract.volume || 0,
      openInterest: contract.openInterest || 0,
      impliedVolatility: contract.iv,
      delta: contract.delta,
      gamma: contract.gamma,
      theta: contract.theta,
      vega: contract.vega,
      inTheMoney: contract.inTheMoney || false,
    };
  }

  setAccessTokens(accessToken: string, accessTokenSecret: string) {
    this.credentials.accessToken = accessToken;
    this.credentials.accessTokenSecret = accessTokenSecret;
  }
}
