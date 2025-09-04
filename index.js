// index.js
require('dotenv').config();
const { ethers } = require("ethers");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // safe for Node <18

// ----------------- CONFIG -----------------
const RPC_URL = process.env.RPC_URL;                  // Arbitrum One RPC
const SEED_PHRASE = process.env.SEED_PHRASE;          // App wallet seed phrase
const ERC20_ADDRESS = process.env.ERC20_ADDRESS;      // ERC20 contract address
const DECIMALS = Number(process.env.DECIMALS) || 18;  // usually 18
const DATABASE_URL = process.env.DATABASE_URL;        // Firebase Realtime DB URL
const SCAN_INTERVAL = 4 * 60 * 60 * 1000;             // 4 hours
const SELF_PING_INTERVAL = 5 * 60 * 1000;             // 5 minutes
const RENDER_URL = process.env.RENDER_URL;            // Optional self-ping

// ----------------- ETHERS SETUP -----------------
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = ethers.Wallet.fromMnemonic(SEED_PHRASE).connect(provider);

const erc20Abi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const tokenContract = new ethers.Contract(ERC20_ADDRESS, erc20Abi, provider);

// ----------------- FIREBASE SETUP -----------------
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
} catch (err) {
  console.error("❌ FIREBASE_KEY_JSON is not valid JSON.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL
});
const db = admin.database();

// ----------------- HELPER: LAST SCANNED BLOCK -----------------
async function getLastScannedBlock() {
  const snapshot = await db.ref("lastScannedBlock").once("value");
  return snapshot.val();
}

async function setLastScannedBlock(blockNumber) {
  await db.ref("lastScannedBlock").set(blockNumber);
}

// ----------------- UPDATE USER BALANCE -----------------
async function updateUserBalance(userWallet, amount) {
  const usersRef = db.ref("user");
  const snapshot = await usersRef.once("value");
  const users = snapshot.val();
  if (!users) return;

  for (const uid in users) {
    if (users[uid].wallet?.toLowerCase() === userWallet.toLowerCase()) {
      const prevBalance = Number(users[uid].balance || 0);
      const newBalance = prevBalance + Number(amount);
      await usersRef.child(uid).update({ balance: newBalance });
      console.log(`✅ Deposit: Updated ${uid}, new balance = ${newBalance}`);
      return;
    }
  }

  console.log(`⚠️ No matching wallet found for ${userWallet}`);
}

// ----------------- LISTEN FOR LIVE DEPOSITS -----------------
tokenContract.on("Transfer", async (from, to, value, event) => {
  try {
    const amount = Number(ethers.utils.formatUnits(value, DECIMALS));
    if (to.toLowerCase() === wallet.address.toLowerCase()) {
      console.log(`💰 Deposit detected! From: ${from}, Amount: ${amount}`);
      await updateUserBalance(from, amount);
      await setLastScannedBlock(event.blockNumber);
    }
  } catch (err) {
    console.error("⚠️ Error handling deposit:", err);
  }
});

// ----------------- SCAN PAST DEPOSITS -----------------
async function scanPastDeposits() {
  try {
    let lastBlock = await getLastScannedBlock();
    const latestBlock = await provider.getBlockNumber();

    if (lastBlock === null) {
      console.log("⚠️ No last scanned block. Initializing to current block...");
      await setLastScannedBlock(latestBlock);
      return;
    }

    if (latestBlock <= lastBlock) {
      console.log("✅ No new blocks to scan.");
      return;
    }

    console.log(`🔍 Scanning past deposits from block ${lastBlock + 1} to ${latestBlock}...`);
    const filter = tokenContract.filters.Transfer(null, wallet.address);
    const events = await tokenContract.queryFilter(filter, lastBlock + 1, latestBlock);

    for (const event of events) {
      try {
        const from = event.args.from;
        const amount = Number(ethers.utils.formatUnits(event.args.value, DECIMALS));
        console.log(`📜 Past deposit: From ${from}, Amount ${amount}`);
        await updateUserBalance(from, amount);
      } catch (innerErr) {
        console.error("⚠️ Error updating balance for past deposit:", innerErr);
      }
    }

    await setLastScannedBlock(latestBlock);
  } catch (err) {
    console.error("⚠️ Error scanning past deposits:", err);
  }
}

// ----------------- SELF-PING FUNCTION -----------------
async function selfPing() {
  if (!RENDER_URL) return;
  try {
    const res = await fetch(RENDER_URL);
    console.log(`🤖 Self-ping at ${new Date().toLocaleTimeString()} - Status: ${res.status}`);
  } catch (err) {
    console.error("⚠️ Self-ping failed:", err.message);
  }
}

// ----------------- GLOBAL ERROR HANDLING -----------------
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
});



// https port for render.com compatibility

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Minimal endpoint just to keep Render happy
app.get("/", (req, res) => res.send("🚀 Deposit listener running!"));

// Start the server
app.listen(PORT, () => {
  console.log(`🌐 Web service listening on port ${PORT}`);
});


// ----------------- STARTUP -----------------
(async () => {
  console.log("🚀 Starting deposit listener...");

  await scanPastDeposits();
  console.log("🚀 Deposit listener active on Arbitrum One.");

  // Periodically scan for missed deposits
  setInterval(async () => {
    try {
      await scanPastDeposits();
    } catch (err) {
      console.error("⚠️ Error in scheduled scan:", err);
    }
  }, SCAN_INTERVAL);

  // Start self-ping interval
  setInterval(selfPing, SELF_PING_INTERVAL);
  selfPing();
})();
