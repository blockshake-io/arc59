import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk, { Address } from 'algosdk';
import { Arc59Client } from '../contracts/clients/Arc59Client';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';

const fixture = algorandFixture();
algokit.Config.configure({ populateAppCallResources: true });

async function sendAsset(
  appClient: Arc59Client,
  assetId: bigint,
  sender: string,
  signer: algosdk.Account,
  receiver: string,
  algorand: algokit.AlgorandClient
): Promise<string | null> {
  const arc59RouterAddress = (await appClient.appClient.getAppReference()).appAddress;

  const [itxns, mbr, routerOptedIn, receiverOptedIn] = (
    await appClient.arc59GetSendAssetInfo({ asset: assetId, receiver })
  ).return!;

  if (receiverOptedIn) {
    await algorand.send.assetTransfer({
      sender,
      receiver,
      assetId,
      amount: 1n,
    });

    return null;
  }

  const composer = appClient.compose();

  if (mbr) {
    const mbrPayment = await algorand.transactions.payment({
      sender,
      receiver: arc59RouterAddress,
      amount: algokit.microAlgos(Number(mbr)),
    });

    composer.addTransaction({ transaction: mbrPayment, signer });
  }

  const axfer = await algorand.transactions.assetTransfer({
    sender,
    receiver: arc59RouterAddress,
    assetId,
    amount: 1n,
  });

  // If the router is not opted in, call arc59OptRouterIn to do so
  if (!routerOptedIn) composer.arc59OptRouterIn({ asa: assetId });

  // Disable resource population to ensure that our manually defined resources are correct
  algokit.Config.configure({ populateAppCallResources: false });

  /** The box of the receiver's pubkey will always be needed */
  const boxes = [algosdk.decodeAddress(receiver).publicKey];

  /** The address of the receiver's inbox */
  const inboxAddress = (await appClient.compose().arc59GetInbox({ receiver }, { boxes }).simulate()).returns[0];
  const sendResult = await composer
    .arc59SendAsset(
      { axfer, receiver },
      {
        sendParams: { fee: algokit.microAlgos(1000 + 1000 * Number(itxns)) },
        boxes, // The receiver's pubkey
        // Always good to include both accounts here, even if we think only the receiver is needed. This is to help protect against race conditions within a block.
        accounts: [receiver, inboxAddress],
        // Even though the asset is available in the group, we need to explicitly define it here because we will be checking the asset balance of the receiver
        assets: [Number(assetId)],
      }
    )
    .execute();

  algokit.Config.configure({ populateAppCallResources: true });

  return sendResult.returns[sendResult.returns.length - 1];
}

describe('Arc59', () => {
  let appClient: Arc59Client;
  let assetOne: bigint;
  let assetTwo: bigint;
  let alice: algosdk.Account;
  let bob: algosdk.Account;

  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { testAccount } = fixture.context;
    const { algorand } = fixture;

    appClient = new Arc59Client(
      {
        sender: testAccount,
        resolveBy: 'id',
        id: 0,
      },
      algorand.client.algod
    );

    const oneResult = await algorand.send.assetCreate({
      sender: testAccount.addr,
      unitName: 'one',
      total: 100n,
    });
    assetOne = BigInt(oneResult.confirmation.assetIndex!);

    const twoResult = await algorand.send.assetCreate({
      sender: testAccount.addr,
      unitName: 'two',
      total: 100n,
    });
    assetTwo = BigInt(twoResult.confirmation.assetIndex!);

    alice = testAccount;

    await appClient.create.createApplication({});

    await appClient.appClient.fundAppAccount({ amount: algokit.microAlgos(100_000) });
  });

  test('routerOptIn', async () => {
    await appClient.appClient.fundAppAccount({ amount: algokit.microAlgos(100_000) });
    await appClient.arc59OptRouterIn({ asa: assetOne }, { sendParams: { fee: algokit.microAlgos(2_000) } });
  });

  test('Brand new account getSendAssetInfo', async () => {
    const res = await appClient.arc59GetSendAssetInfo({ asset: assetOne, receiver: algosdk.generateAccount().addr });

    const itxns = res.return![0];
    const mbr = res.return![1];

    expect(itxns).toBe(5n);
    expect(mbr).toBe(228_100n);
  });

  test('Brand new account sendAsset', async () => {
    const { algorand } = fixture;
    const { testAccount } = fixture.context;
    bob = testAccount;

    await sendAsset(appClient, assetOne, alice.addr, alice, bob.addr, algorand);
  });

  test('Existing inbox sendAsset (existing asset)', async () => {
    const { algorand } = fixture;

    await sendAsset(appClient, assetOne, alice.addr, alice, bob.addr, algorand);
  });

  test('Existing inbox sendAsset (new asset)', async () => {
    const { algorand } = fixture;

    await sendAsset(appClient, assetTwo, alice.addr, alice, bob.addr, algorand);
  });

  test('claim', async () => {
    const { algorand } = fixture;

    await algorand.send.assetOptIn({ assetId: assetOne, sender: bob.addr });
    await appClient.arc59Claim({ asa: assetOne }, { sender: bob, sendParams: { fee: algokit.algos(0.003) } });

    const bobAssetInfo = await algorand.account.getAssetInformation(bob.addr, assetOne);

    expect(bobAssetInfo.balance).toBe(2n);
  });

  test('reject', async () => {
    const { algorand } = fixture;
    const newAsset = BigInt(
      (await algorand.send.assetCreate({ sender: alice.addr, total: 1n })).confirmation.assetIndex!
    );
    await sendAsset(appClient, newAsset, alice.addr, alice, bob.addr, algorand);

    await appClient.arc59Reject({ asa: newAsset }, { sender: bob, sendParams: { fee: algokit.algos(0.003) } });
  });

  test('0-ALGO claiming', async () => {
    const { algorand } = fixture;
    const algod = algorand.client.algod;

    // this is a 0-ALGO account that will claim the asset
    const eve = await fixture.context.generateAccount({
      initialFunds: AlgoAmount.MicroAlgos(0),
    });

    // send asset to Eve plus some extra ALGO to claim
    const inboxAddress = await sendAsset(appClient, assetOne, alice.addr, alice, eve.addr, algorand);
    const suggestedParams = await algod.getTransactionParams().do();
    await algod.sendRawTransaction(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: alice.addr,
      to: inboxAddress!,
      amount: 206_000,
      suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    }).signTxn(alice.sk)).do();
    console.log("Eve's inbox: " + inboxAddress);

    // make sure that Eve doesn't have ALGO and any ASA in her account
    let eveAccountInfo = await algorand.account.getInformation(eve.addr);
    expect(eveAccountInfo.amount).toBe(0);

    // claiming
    const composer = appClient.compose();
    composer.arc59Fund({}, {
      sender: eve,
      sendParams: { fee: algokit.microAlgos(0) },
      boxes: [algosdk.decodeAddress(eve.addr).publicKey],
      accounts: [eve.addr, inboxAddress!],
      assets: [Number(assetOne)],
    });

    const optInTxn = await algorand.transactions.assetTransfer({
      sender: eve.addr,
      receiver: eve.addr,
      assetId: assetOne,
      amount: 0n,
    });
    composer.addTransaction({
      transaction: optInTxn,
      signer: eve,
    });

    composer.arc59Claim({
      asa: Number(assetOne)
    }, {
      sender: eve,
      sendParams: { fee: algokit.microAlgos(6000) },
      boxes: [algosdk.decodeAddress(eve.addr).publicKey],
      accounts: [eve.addr, inboxAddress!],
      assets: [Number(assetOne)],
    });

    await composer.execute();

    // now Eve should have ALGO and an ASA
    // eveAccountInfo = await algorand.account.getInformation(eve.addr);
    // expect(eveAccountInfo.amount).toBe(200_000);
    let eveAssetInfo = await algorand.account.getAssetInformation(eve.addr, assetOne);
    expect(eveAssetInfo.balance).toBe(1n);
  });
});
