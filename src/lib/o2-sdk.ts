import { O2Api, TraderAccount, Action, OrderSide, OrderType } from "@o2exchange/sdk";
import { Provider, Wallet } from "fuels";
import {
  resolveApiBaseUrl,
  resolveOwnerPrivateKey,
  resolveProviderUrl,
  resolveSessionPrivateKey,
  resolveSessionStorePath,
} from "./o2-config";
import { RestAPI } from "../../lib/rest-api/client";
import { FuelSessionSigner } from "../../lib/rest-api/signers/fuel-signer";
import { ConfigurationRestAPI, OrderSide as RestOrderSide, OrderType as RestOrderType, MarketResponse } from "../../lib/rest-api/types";
import Decimal from "decimal.js";
import { scaleUpAndTruncateToInt, calculateBaseQuantity } from "./utils/scaling";
import { findValidSessionForTradeAccount, saveSession } from "./o2-session-store";

const DEFAULT_SESSION_EXPIRY_MS = 48 * 60 * 60 * 1000;

type ApiConfig = {
  apiBaseUrl?: string;
  providerUrl?: string;
  pair: [string, string];
};

type SessionCreateParams = ApiConfig & {
  tradeAccountId: string;
  ownerPrivateKey?: string;
  sessionPrivateKey?: string;
  contractIds?: string[];
  expiryMs?: number;
  ownerNonce?: string | number;
};

type SessionCreateResult = {
  response: unknown;
  sessionAddress: string;
  sessionPrivateKey: string;
  sessionWasGenerated: boolean;
  nonceUsed: string;
  expiryMs: number;
};

type PlaceOrderParams = ApiConfig & {
  tradeAccountId: string;
  sessionPrivateKey?: string;
  side: "Buy" | "Sell";
  orderType?: "Spot" | "Market" | "FillOrKill" | "PostOnly";
  price: string | number;
  quantity: string | number;
};

type PlaceOrderResult = {
  response: unknown;
  side: "Buy" | "Sell";
  orderType: "Spot" | "Market" | "FillOrKill" | "PostOnly";
};

function toBigInt(value: string | number): bigint {
  return BigInt(String(value));
}

function normalizeOrderType(type?: "Spot" | "Market" | "FillOrKill" | "PostOnly"): OrderType {
  switch (type) {
    case "Market":
      return OrderType.Market;
    case "Spot":
    case "FillOrKill":
    case "PostOnly":
    default:
      return OrderType.Spot;
  }
}

function normalizeOrderSide(side: "Buy" | "Sell"): OrderSide {
  return side === "Sell" ? OrderSide.Sell : OrderSide.Buy;
}

async function getProvider(url: string) {
  const provider = new Provider(url);
  await provider.init();
  return provider;
}

export async function createSessionWithSdk(
  params: SessionCreateParams
): Promise<SessionCreateResult> {
  const apiBaseUrl = resolveApiBaseUrl(params.apiBaseUrl);
  const providerUrl = resolveProviderUrl(params.providerUrl);
  const ownerPrivateKey = resolveOwnerPrivateKey(params.ownerPrivateKey);
  if (!ownerPrivateKey) {
    throw new Error(
      "Owner private key is required. Provide ownerPrivateKey or set O2_PRIVATE_KEY."
    );
  }

  const o2Api = await O2Api.create({
    api: apiBaseUrl,
    provider: providerUrl,
    pair: params.pair,
  });

  const provider = await getProvider(providerUrl);
  const ownerWallet = Wallet.fromPrivateKey(ownerPrivateKey, provider);

  const resolvedSessionKey =
    resolveSessionPrivateKey(params.sessionPrivateKey) ?? null;
  const sessionWasGenerated = !resolvedSessionKey;
  const sessionWallet = resolvedSessionKey
    ? Wallet.fromPrivateKey(resolvedSessionKey, provider)
    : Wallet.generate({ provider });

  const marketsResponse = params.contractIds
    ? null
    : await o2Api.getMarkets();
  const contractIds =
    params.contractIds ??
    (marketsResponse?.markets ?? []).map((market: { contract_id: string }) => {
      return market.contract_id;
    });

  if (!contractIds.length) {
    throw new Error("No contract IDs available for session creation.");
  }

  const accountInfo = await o2Api.getAccount(params.tradeAccountId);
  const nonceValue =
    params.ownerNonce ?? (accountInfo?.nonce as string | number | undefined);
  if (nonceValue === undefined) {
    throw new Error("Unable to resolve owner nonce for session creation.");
  }

  const expiryMs = params.expiryMs ?? Date.now() + DEFAULT_SESSION_EXPIRY_MS;

  const response = await o2Api.createSession(
    ownerWallet,
    params.tradeAccountId,
    sessionWallet.address,
    nonceValue,
    contractIds,
    expiryMs
  );

  return {
    response,
    sessionAddress: sessionWallet.address.toString(),
    sessionPrivateKey: sessionWallet.privateKey,
    sessionWasGenerated,
    nonceUsed: String(nonceValue),
    expiryMs,
  };
}

export async function placeOrderWithSdk(
  params: PlaceOrderParams
): Promise<PlaceOrderResult> {
  const apiBaseUrl = resolveApiBaseUrl(params.apiBaseUrl);
  const providerUrl = resolveProviderUrl(params.providerUrl);
  const sessionPrivateKey = resolveSessionPrivateKey(params.sessionPrivateKey);
  if (!sessionPrivateKey) {
    throw new Error(
      "Session private key is required. Provide sessionPrivateKey or set O2_SESSION_PRIVATE_KEY."
    );
  }

  const traderAccount = await TraderAccount.create({
    api: apiBaseUrl,
    provider: providerUrl,
    pair: params.pair,
    tradeAccountId: params.tradeAccountId,
    sessionKey: sessionPrivateKey,
  });

  const side = normalizeOrderSide(params.side);
  const orderType = normalizeOrderType(params.orderType);

  const response = await traderAccount.executeActions([
    {
      type: Action.CreateOrder,
      payload: {
        type: orderType,
        side,
        price: toBigInt(params.price),
        quantity: toBigInt(params.quantity),
      },
    },
  ]);

  return {
    response,
    side: params.side,
    orderType: params.orderType ?? "Spot",
  };
}

type PlaceOrderWithRestApiParams = ApiConfig & {
  tradeAccountId: string;
  sessionPrivateKey?: string;
  side: "Buy" | "Sell";
  orderType?: "Spot" | "Market" | "FillOrKill" | "PostOnly";
  rawPrice?: string | number;
  rawQuantity?: string | number;
  price?: string | number;
  quantity?: string | number;
};

type PlaceOrderWithRestApiResult = {
  response: unknown;
  side: "Buy" | "Sell";
  orderType: "Spot" | "Market" | "FillOrKill" | "PostOnly";
  scaledPrice?: string;
  scaledQuantity?: string;
};

function normalizeRestOrderType(type?: "Spot" | "Market" | "FillOrKill" | "PostOnly"): RestOrderType {
  switch (type) {
    case "Market":
      return RestOrderType.Market;
    case "FillOrKill":
      return RestOrderType.FillOrKill;
    case "PostOnly":
      return RestOrderType.PostOnly;
    case "Spot":
    default:
      return RestOrderType.Spot;
  }
}

function normalizeRestOrderSide(side: "Buy" | "Sell"): RestOrderSide {
  return side === "Sell" ? RestOrderSide.Sell : RestOrderSide.Buy;
}

export async function placeOrderWithRestApi(
  params: PlaceOrderWithRestApiParams
): Promise<PlaceOrderWithRestApiResult> {
  const apiBaseUrl = resolveApiBaseUrl(params.apiBaseUrl);
  const providerUrl = resolveProviderUrl(params.providerUrl);
  const ownerPrivateKey = resolveOwnerPrivateKey();
  if (!ownerPrivateKey) {
    throw new Error(
      "Owner private key is required. Set O2_PRIVATE_KEY environment variable."
    );
  }

  const sessionStorePath = resolveSessionStorePath();

  const client = new RestAPI(new ConfigurationRestAPI({
    basePath: apiBaseUrl,
    timeout: 30000,
    retries: 3,
    backoff: 1000,
    baseOptions: {},
    logger: console,
  }));

  const provider = await getProvider(providerUrl);
  const ownerWallet = Wallet.fromPrivateKey(ownerPrivateKey, provider);

  const marketsResponse = await client.getMarkets();
  const markets: MarketResponse[] = (await marketsResponse.data()).markets;
  const marketContractIds = markets.map(m => m.contract_id);

  const existingSession = await findValidSessionForTradeAccount(
    params.tradeAccountId,
    sessionStorePath
  );

  let signer: FuelSessionSigner;

  if (existingSession) {
    console.log(`Reusing existing session ${existingSession.sessionId} (expires: ${new Date(existingSession.expiryMs!).toISOString()})`);
    signer = new FuelSessionSigner(existingSession.sessionPrivateKey);
  } else {
    console.log('No valid session found, creating new session');
    signer = new FuelSessionSigner();
  }

  await client.initTradeAccountManager({
    account: ownerWallet,
    signer: signer,
    tradeAccountId: params.tradeAccountId,
    contractIds: marketContractIds,
  });

  if (!existingSession) {
    const expiryMs = Date.now() + DEFAULT_SESSION_EXPIRY_MS;
    await saveSession({
      sessionPrivateKey: signer.privateKey,
      sessionAddress: signer.address.toString(),
      tradeAccountId: params.tradeAccountId,
      expiryMs: expiryMs,
      storePath: sessionStorePath,
    });
    console.log(`New session created and saved (expires: ${new Date(expiryMs).toISOString()})`);
  }

  const market = markets.find(m =>
    m.base.symbol === params.pair[0] && m.quote.symbol === params.pair[1]
  );

  if (!market) {
    throw new Error(`Market ${params.pair[0]}/${params.pair[1]} not found`);
  }

  let finalPrice: string;
  let finalQuantity: string;

  if (params.rawPrice !== undefined && params.rawQuantity !== undefined) {
    const rawPriceDecimal = new Decimal(String(params.rawPrice));
    const rawQuantityDecimal = new Decimal(String(params.rawQuantity));

    const scaledPrice = scaleUpAndTruncateToInt(
      rawPriceDecimal,
      market.quote.decimals,
      market.quote.max_precision
    );

    const scaledQuantity = calculateBaseQuantity(
      rawQuantityDecimal,
      rawPriceDecimal,
      market.base.decimals,
      market.base.max_precision
    );

    finalPrice = scaledPrice.toString();
    finalQuantity = scaledQuantity.toString();
  } else if (params.price !== undefined && params.quantity !== undefined) {
    finalPrice = String(params.price);
    finalQuantity = String(params.quantity);
  } else {
    throw new Error("Either (rawPrice and rawQuantity) or (price and quantity) must be provided");
  }

  const side = normalizeRestOrderSide(params.side);
  const orderType = normalizeRestOrderType(params.orderType);

  const response = await client.sessionSubmitTransaction({
    market,
    actions: [{
      CreateOrder: {
        side,
        order_type: orderType,
        price: finalPrice,
        quantity: finalQuantity,
      }
    }]
  });

  const data = await response.data();

  return {
    response: data,
    side: params.side,
    orderType: params.orderType ?? "Spot",
    scaledPrice: finalPrice,
    scaledQuantity: finalQuantity,
  };
}

type CancelOrderWithRestApiParams = ApiConfig & {
  tradeAccountId: string;
  orderId: string;
};

type CancelOrderWithRestApiResult = {
  response: unknown;
};

export async function cancelOrderWithRestApi(
  params: CancelOrderWithRestApiParams
): Promise<CancelOrderWithRestApiResult> {
  const apiBaseUrl = resolveApiBaseUrl(params.apiBaseUrl);
  const providerUrl = resolveProviderUrl(params.providerUrl);
  const ownerPrivateKey = resolveOwnerPrivateKey();
  if (!ownerPrivateKey) {
    throw new Error(
      "Owner private key is required. Set O2_PRIVATE_KEY environment variable."
    );
  }

  const sessionStorePath = resolveSessionStorePath();

  const client = new RestAPI(new ConfigurationRestAPI({
    basePath: apiBaseUrl,
    timeout: 30000,
    retries: 3,
    backoff: 1000,
    baseOptions: {},
    logger: console,
  }));

  const provider = await getProvider(providerUrl);
  const ownerWallet = Wallet.fromPrivateKey(ownerPrivateKey, provider);

  const marketsResponse = await client.getMarkets();
  const markets: MarketResponse[] = (await marketsResponse.data()).markets;
  const marketContractIds = markets.map(m => m.contract_id);

  const existingSession = await findValidSessionForTradeAccount(
    params.tradeAccountId,
    sessionStorePath
  );

  let signer: FuelSessionSigner;

  if (existingSession) {
    console.log(`Reusing existing session ${existingSession.sessionId} (expires: ${new Date(existingSession.expiryMs!).toISOString()})`);
    signer = new FuelSessionSigner(existingSession.sessionPrivateKey);
  } else {
    console.log('No valid session found, creating new session');
    signer = new FuelSessionSigner();
  }

  await client.initTradeAccountManager({
    account: ownerWallet,
    signer: signer,
    tradeAccountId: params.tradeAccountId,
    contractIds: marketContractIds,
  });

  if (!existingSession) {
    const expiryMs = Date.now() + DEFAULT_SESSION_EXPIRY_MS;
    await saveSession({
      sessionPrivateKey: signer.privateKey,
      sessionAddress: signer.address.toString(),
      tradeAccountId: params.tradeAccountId,
      expiryMs: expiryMs,
      storePath: sessionStorePath,
    });
    console.log(`New session created and saved (expires: ${new Date(expiryMs).toISOString()})`);
  }

  const market = markets.find(m =>
    m.base.symbol === params.pair[0] && m.quote.symbol === params.pair[1]
  );

  if (!market) {
    throw new Error(`Market ${params.pair[0]}/${params.pair[1]} not found`);
  }

  const response = await client.sessionSubmitTransaction({
    market,
    actions: [{
      CancelOrder: {
        order_id: params.orderId as `0x${string}`
      }
    }]
  });

  const data = await response.data();

  return {
    response: data,
  };
}
