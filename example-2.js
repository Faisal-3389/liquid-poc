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
    const receivingNode = accountNode.derive(0).derive(2);
    const blindingKey = ecc.pointFromScalar(receivingNode.privateKey);

    const { confidentialAddress } = payments.p2wpkh({
        pubkey: Buffer.from(receivingNode.publicKey),
        blindkey: Buffer.from(blindingKey),
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

async function unblindUTXO(utxo, blindingKey) {
    try {
        const rawTxHex = await getRawTx(utxo.txid);
        const tx = Transaction.fromHex(rawTxHex);
        const output = tx.outs[utxo.vout];
        const unblinded = confi.unblindOutputWithKey({
            value: output.value || Buffer.alloc(0),
            asset: output.asset || Buffer.alloc(0),
            nonce: output.nonce || Buffer.alloc(0),
            rangeProof: output.rangeProof || Buffer.alloc(0),
            script: output.script || Buffer.alloc(0),
        }, blindingKey);

        if (unblinded.asset.toString("hex") !== networks.liquid.assetHash) {
            console.log(`The Asset Hash for LBTC should be ${networks.liquid.assetHash}`);
        }
        const asset = networks.liquid.assetHash;
        return {
            value: Number(unblinded.value),
            asset: asset,
            blinder: unblinded.blinder ? unblinded.blinder.toString("hex") : "undefined",
            valueBlindingFactor: unblinded.valueBlindingFactor ? unblinded.valueBlindingFactor.toString("hex") : "undefined",
            assetBlindingFactor: unblinded.assetBlindingFactor ? unblinded.assetBlindingFactor.toString("hex") : "undefined",
        };
    } catch (error) {
        console.error("Error unblinding UTXO:", error);
        throw error;
    }
}


function ensurePositiveInteger(buffer) {
    if (buffer[0] & 0x80) {
        return Buffer.concat([Buffer.from([0x00]), buffer]);
    }
    return buffer;
}

const bip66 = require('bip66');

function ensurePositiveInteger(buffer) {
    if (buffer[0] & 0x80) {
        return Buffer.concat([Buffer.from([0x00]), buffer]);
    }
    return buffer;
}

function encodeToDER(rawSignature) {
    const r = rawSignature.slice(0, 32); // First 32 bytes are R
    const s = rawSignature.slice(32, 64); // Next 32 bytes are S
    const adjustedR = ensurePositiveInteger(r);
    const adjustedS = ensurePositiveInteger(s);
    return bip66.encode(adjustedR, adjustedS);
}

function signAndFinalizeInput(pset, inIndex, privateKey, {
    sighashType = 0x01,
    genesisBlockHash,
} = {}) {
    // 1) Create an ECPair from the private key
    const keyPair = ECPair.fromPrivateKey(privateKey, { compressed: true });

    if (keyPair.publicKey.length !== 33) {
        throw new Error("Public key is not compressed. Ensure it is 33 bytes long.");
    }

    // 2) Build an ECDSA signature validator:
    const validator = Pset.ECDSASigValidator({
        verify(h, Q, signature) {
            return ecc.verify(h, Q, signature);
        },
    });

    // 3) Compute the sighash
    const sighash = pset.getInputPreimage(inIndex, sighashType, genesisBlockHash);

    // 4) Sign the sighash with your private key (ECDSA)
    // Generate raw signature
    const rawSignature = keyPair.sign(sighash);
    // console.log("Raw Signature:", rawSignature.toString("hex")); // --> current_error, this does not start with 0x30 for the DER encoding

    // Encode the raw signature to DER
    const signatureDER = encodeToDER(rawSignature);
    // console.log("Signature (DER):", signatureDER.toString("hex"));

    // Tell the PSET which sighash type we're using on this input:
    pset.inputs[inIndex].sighashType = sighashType;

    // By convention, Bitcoin - style ECDSA signatures include the sighash byte at the end:
    const signatureWithHashType = Buffer.concat([signatureDER, Buffer.from([sighashType])]);

    // 5) Build the partialSig object
    const partialSig = {
        pubkey: Buffer.from(keyPair.publicKey),
        signature: signatureWithHashType, // signatureDER // signatureWithHashType, --> current_error
    };

    // 6) Use `Signer` to store that signature in the PSET
    const signer = new Signer(pset);
    signer.addSignature(inIndex, { partialSig, sighashType }, validator);

    // 7) Finalize the input
    new Finalizer(pset).finalize();
    return pset;
}


function validateTransactionBalance(pset) {
    try {
        let totalInputs = 0;
        let totalOutputs = 0;
        const inputAssets = {};
        const outputAssets = {};

        // Validate inputs
        pset.inputs.forEach((input, index) => {
            if (!input.witnessUtxo) {
                throw new Error(`Input ${index} is missing witnessUtxo.`);
            }
            const value = confidential.confidentialValueToSatoshi(input.witnessUtxo.value);
            const asset = input.witnessUtxo.asset.toString('hex');
            totalInputs += value;
            if (!inputAssets[asset]) inputAssets[asset] = 0;
            inputAssets[asset] += value;
        });

        // Validate outputs
        pset.outputs.forEach((output, index) => {
            const value = output.value;
            const asset = output.asset.toString('hex');
            totalOutputs += value;
            if (!outputAssets[asset]) outputAssets[asset] = 0;
            outputAssets[asset] += value;
        });

        const fee = totalInputs - totalOutputs;

        if (fee < 0) {
            throw new Error(`Outputs exceed inputs by ${-fee} satoshis.`);
        }

        console.log(`Total Inputs: ${totalInputs} satoshis`);
        console.log(`Total Outputs: ${totalOutputs} satoshis`);
        console.log(`Transaction Fee: ${fee} satoshis`);

        // Check for asset mismatches
        Object.keys(inputAssets).forEach((asset) => {
            if (!outputAssets[asset] || inputAssets[asset] !== outputAssets[asset] + fee) {
                throw new Error(`Asset mismatch for ${asset}. Input: ${inputAssets[asset]}, Output: ${outputAssets[asset]}`);
            }
        });
        return 'Transaction balance is valid.';
    } catch (err) {
        console.error("Validation Error:", err);
        throw err;
    }
}


async function sendLBTCviaPsetv2({
    unblindedUTXO,
    utxo,
    recipientConfAddr,
    senderConfAddr,
    privateKey,
    network = networks.liquid,
}) {
    // 1) Calculate amounts
    const amountToSend = Math.floor(unblindedUTXO.value * 0.3); // 30%
    const fee = 500;
    const changeValue = unblindedUTXO.value - amountToSend - fee;
    if (changeValue < 0) throw new Error("Not enough UTXO balance.");

    // 3) Prepare unblinded asset buffer (33 bytes: 0x01 + reversed 32-byte ID)
    const unblindedAsset = Buffer.concat([
        Buffer.from('01', 'hex'),
        Buffer.from(unblindedUTXO.asset, 'hex').reverse(),
    ]);

    // 4) Convert both addresses to unconf scripts
    const { unconfidentialAddress: recipientUnconf } = address.fromConfidential(
        recipientConfAddr,
        network
    );
    const recipientScript = payments.p2wpkh({
        address: recipientUnconf,
        network,
    }).output;

    const { unconfidentialAddress: senderUnconf } = address.fromConfidential(
        senderConfAddr,
        network
    );
    const changeScript = payments.p2wpkh({ address: senderUnconf, network }).output;

    // 5) Create a new empty Pset
    const pset = Creator.newPset();

    // 6) Build a PsetInput for the UTXO
    const input = new PsetInput();
    input.previousTxid = Buffer.from(utxo.txid, 'hex').reverse();
    input.previousTxIndex = utxo.vout;
    // Provide witnessUtxo so we can sign it
    input.witnessUtxo = {
        script: payments
            .p2wpkh({ address: senderUnconf, network })
            .output,
        value: confidential.satoshiToConfidentialValue(unblindedUTXO.value), // unblindedUTXO.value  // confidential.satoshiToConfidentialValue(unblindedUTXO.value), --> current_error
        asset: unblindedAsset,
        nonce: Buffer.alloc(1, 0), // 0x00 for unblinded
    };
    pset.addInput(input);

    // 7) Create recipient output
    const recipientOut = new PsetOutput();
    recipientOut.script = recipientScript;
    recipientOut.value = amountToSend;
    recipientOut.asset = unblindedAsset;
    recipientOut.nonce = Buffer.alloc(1, 0);
    pset.addOutput(recipientOut);

    // 8) Create change output
    const changeOut = new PsetOutput();
    changeOut.script = changeScript;
    changeOut.value = changeValue;
    changeOut.asset = unblindedAsset;
    changeOut.nonce = Buffer.alloc(1, 0);
    pset.addOutput(changeOut);

    // 9) Create change output for fee
    // const changeOutFee = new PsetOutput();
    // changeOutFee.script = Buffer.alloc(0); // empty scriptPubKey, // feeScript;
    // changeOutFee.value = fee;
    // changeOutFee.asset = unblindedAsset;
    // changeOutFee.nonce = Buffer.alloc(1, 0);
    // pset.addOutput(changeOutFee);

    // 8.a) Validate the PSET
    validateTransactionBalance(pset);

    // 9) Sign & finalize the first input
    signAndFinalizeInput(pset, 0, privateKey, {
        sighashType: 0x01, // SIGHASH_ALL
        genesisBlockHash: network.genesisBlockHash,
    });

    // 10) Extract the transaction
    const finalTx = Extractor.extract(pset);
    const hex = finalTx.toHex();
    console.log('Final TX hex:', hex);

    return hex;
}

const postTx = async (rawTx) => {
    try {
        const response = await axios.post('https://blockstream.info/liquid/api/tx', rawTx, {
            headers: { 'Content-Type': 'text/plain' }
        });
        return response.data;
    } catch (error) {
        console.error('Error broadcasting transaction:', error.response.data);
        throw error;
    }
}

(async () => {
    try {
        await setupConfidential();
        const mnemonic = "bread captain scissors raise share disorder curious half motor ready noodle panic";
        const { privateKey, confidentialAddress, blindingKey } = createNewLiquidAddress(mnemonic);
        const utxos = await getUTXOs(confidentialAddress);

        if (utxos.length > 0) {
            const firstUTXO = utxos[0];
            const unblindedUTXO = await unblindUTXO(firstUTXO, privateKey);

            const txHex = await sendLBTCviaPsetv2({
                unblindedUTXO,
                utxo: firstUTXO,
                recipientConfAddr: LBTC_RECEIVER_ADDRESS,
                senderConfAddr: confidentialAddress,
                privateKey,
                network: networks.liquid,
            });

            await postTx(txHex);
        } else {
            console.log("No UTXOs available.");
        }
    } catch (err) {
        console.error("Error:", err);
    }
})();
