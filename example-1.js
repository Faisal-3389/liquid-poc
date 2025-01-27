const LBTC_RECEIVER_ADDRESS = 'lq1qqf7famh8972utgv96p25xd4lt5ln4snznptezz2dt4x2u3k4zm5jcwx3n8zp4z9mcytdf3tw9vnlr963zyzm727t7tn00ecnl';
const { mnemonicToSeedSync } = require("bip39");
const { BIP32Factory } = require("bip32");
const ecc = require("tiny-secp256k1");
const axios = require("axios");
const zkpInit = require('@vulpemventures/secp256k1-zkp').default;
const { initEccLib } = require('bitcoinjs-lib');
const { confidential, Transaction, networks, payments, address, Creator, Pset, PsetInput,
    PsetOutput,
    Finalizer,
    Extractor, Signer,
} = require("liquidjs-lib");
const ECPairFactory = require('ecpair').ECPairFactory;

const bip32 = BIP32Factory(ecc);
let confi;
let ECPair;

// Setup function to initialize confi
async function setupConfidential() {
    try {
        initEccLib(ecc);
        const zkp = await zkpInit();
        confi = new confidential.Confidential(zkp);
        ECPair = ECPairFactory(ecc);
        console.log("Setup completed. Confidential instance is ready.");
    } catch (error) {
        console.error("Error during setup:", error);
        throw error;
    }
}


function createNewLiquidAddress(mnemonic) {
    const seed = mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed);
    const accountNode = root.derivePath("m/84'/1776'/0'");
    const receivingNode = accountNode.derive(0).derive(1);
    const blindingKey = ecc.pointFromScalar(receivingNode.privateKey);
    const { confidentialAddress } = payments.p2wpkh({
        pubkey: receivingNode.publicKey,
        blindkey: blindingKey,
        network: networks.liquid,
    });
    return { privateKey: receivingNode.privateKey, confidentialAddress, blindingKey };
}

async function getUTXOs(address) {
    const url = `https://blockstream.info/liquid/api/address/${address}/utxo`;
    const response = await axios.get(url);
    return response.data;
}

async function getRawTx(txid) {
    const url = `https://blockstream.info/liquid/api/tx/${txid}/hex`;
    const response = await axios.get(url);
    return response.data;
}

async function unblindUTXO(confidential, utxo, blindingKey) {
    const rawTxHex = await getRawTx(utxo.txid);
    const tx = Transaction.fromHex(rawTxHex);
    const output = tx.outs[utxo.vout];
    return confi.unblindOutputWithKey({
        value: output.value,
        asset: output.asset,
        nonce: output.nonce,
        script: output.script,
        rangeProof: output.rangeProof,
    }, blindingKey);
}

function signAndFinalizeInput(pset, index, privateKey) {
    const keyPair = ECPair.fromPrivateKey(privateKey);
    const sighash = pset.getInputPreimage(index, 0x01, networks.liquid.genesisBlockHash);
    const signature = keyPair.sign(sighash);
    const signatureDER = Buffer.concat([signature, Buffer.from([0x01])]);
    const signer = new Signer(pset);
    signer.addSignature(index, { pubkey: keyPair.publicKey, signature: signatureDER });
    new Finalizer(pset).finalize();
}

async function sendLBTCviaPsetv2({ unblindedUTXO, utxo, recipientConfAddr, senderConfAddr, privateKey }) {
    const amountToSend = Math.floor(unblindedUTXO.value * 0.1);
    const fee = 300;
    const changeValue = unblindedUTXO.value - amountToSend - fee;

    const recipientScript = payments.p2wpkh({ address: address.fromConfidential(recipientConfAddr).unconfidentialAddress, network: networks.liquid }).output;
    const changeScript = payments.p2wpkh({ address: address.fromConfidential(senderConfAddr).unconfidentialAddress, network: networks.liquid }).output;

    const pset = Creator.newPset();

    const input = new PsetInput();
    input.previousTxid = Buffer.from(utxo.txid, 'hex').reverse();
    input.previousTxIndex = utxo.vout;
    input.witnessUtxo = {
        script: changeScript,
        value: confidential.satoshiToConfidentialValue(unblindedUTXO.value),
        asset: Buffer.concat([Buffer.from('01', 'hex'), Buffer.from(unblindedUTXO.asset, 'hex').reverse()]),
        nonce: Buffer.alloc(1, 0),
    };
    pset.addInput(input);

    const recipientOut = new PsetOutput();
    recipientOut.script = recipientScript;
    recipientOut.value = confidential.satoshiToConfidentialValue(amountToSend);
    recipientOut.asset = input.witnessUtxo.asset;
    recipientOut.nonce = Buffer.alloc(1, 0);
    pset.addOutput(recipientOut);

    const changeOut = new PsetOutput();
    changeOut.script = changeScript;
    changeOut.value = confidential.satoshiToConfidentialValue(changeValue);
    changeOut.asset = input.witnessUtxo.asset;
    changeOut.nonce = Buffer.alloc(1, 0);
    pset.addOutput(changeOut);

    signAndFinalizeInput(pset, 0, privateKey);

    const finalTx = Extractor.extract(pset);
    return finalTx.toHex();
}

(async () => {
    try {
        const confidential = await setupConfidential();
        const mnemonic = "bread captain scissors raise share disorder curious half motor ready noodle panic";
        const { privateKey, confidentialAddress, blindingKey } = createNewLiquidAddress(mnemonic);
        const utxos = await getUTXOs(confidentialAddress);

        if (utxos.length > 0) {
            const firstUTXO = utxos[0];
            const unblindedUTXO = await unblindUTXO(confidential, firstUTXO, blindingKey);
            const txHex = await sendLBTCviaPsetv2({
                unblindedUTXO,
                utxo: firstUTXO,
                recipientConfAddr: LBTC_RECEIVER_ADDRESS,
                senderConfAddr: confidentialAddress,
                privateKey,
            });
            await axios.post('https://blockstream.info/liquid/api/tx', txHex, { headers: { 'Content-Type': 'text/plain' } });
        } else {
            console.log("No UTXOs available.");
        }
    } catch (err) {
        console.error("Error:", err);
    }
})();