#!/usr/bin/env node
const LBTC_RECEIVER_ADDRESS = '';
const MNEMONIC = "";
const SEND_AMOUNT_SATS = BigInt(200);

import * as lwk from 'lwk_wasm';

async function main() {
    // 1) Hardcode the mnemonic, address, and amount
    const DESTINATION_CONF_ADDR = LBTC_RECEIVER_ADDRESS;

    // 2) Initialize Liquid mainnet
    const network = lwk.Network.mainnet();

    // 3) Create a software signer from the mnemonic
    let mnemonic;
    try {
        mnemonic = new lwk.Mnemonic(MNEMONIC);
    } catch (err) {
        console.error("Invalid mnemonic:", err);
        process.exit(1);
    }
    const signer = new lwk.Signer(mnemonic, network);

    // 4) Build a descriptor (Slip77 + wpkh)
    const descriptor = signer.wpkhSlip77Descriptor();
    console.log("Descriptor:", descriptor.toString());

    // 5) Create the Wollet from that descriptor
    const wollet = new lwk.Wollet(network, descriptor);

    // 6) Connect to an Esplora-based Liquid mainnet endpoint
    //    e.g. Blockstream's official Liquid explorer
    const esploraUrlMainnet = "https://waterfalls.liquidwebwallet.org/liquid/api"
    const client = new lwk.EsploraClient(network, esploraUrlMainnet);

    // 7) Full scan to discover UTXOs & balance
    console.log("Scanning the descriptor on Liquid Mainnet...");
    const update = await client.fullScan(wollet);
    if (update instanceof lwk.Update) {
        wollet.applyUpdate(update);
    }
    console.log("Scan complete.");

    // 8) Print current balance (asset => amount in sats)
    const balanceMap = wollet.balance();
    console.log("Current wallet balance:");
    balanceMap.forEach((amount, assetId) => {
        console.log(`  ${assetId}: ${amount} sats`);
    });

    // 8.1) Enumerate addresses that actually hold UTXOs
    for (let i = 0; i < 5; i++) {
        // address(index) returns an AddressResult object
        const addrResult = wollet.address(i);

        // from that, you can get the .address() 
        // which is an lwk.Address object
        const addressStr = addrResult.address().toString();

        console.log(`Index ${i} => ${addressStr}`);
    }

    // 9) Build a transaction sending SEND_AMOUNT_SATS of L-BTC
    //    to the hardcoded DESTINATION_CONF_ADDR
    const builder = new lwk.TxBuilder(network)
        .enableCtDiscount()  // typical discounted fee for Liquid
        .addRecipient(
            new lwk.Address(DESTINATION_CONF_ADDR),
            SEND_AMOUNT_SATS,
            network.policyAsset() // mainnet L-BTC asset ID
        );

    // 10) Finish the PSET
    let pset;
    try {
        pset = builder.finish(wollet);
    } catch (err) {
        console.error("Error building transaction:", err);
        process.exit(1);
    }
    console.log("PSET created. Signing...");

    // 11) Sign with software signer
    let signedPset;
    try {
        const psetInstance = new lwk.Pset(pset.toString());
        signedPset = signer.sign(psetInstance);
        console.log("Transaction signed successfully.");
    } catch (err) {
        console.error("Error signing transaction:", err);
        process.exit(1);
    }

    // 12) Finalize & broadcast
    let txid;
    try {
        const finalized = wollet.finalize(signedPset);
        const txHex = finalized.extractTx().toString();
        console.log("Final tx hex:", txHex);

        txid = await client.broadcast(finalized);
        console.log("Broadcast success:", txid);
    } catch (err) {
        console.error("Failed to finalize or broadcast:", err);
        process.exit(1);
    }

    console.log(`Broadcast success! TxID: ${txid}`);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
