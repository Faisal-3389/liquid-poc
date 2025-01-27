# liquid-poc
Liquid-poc

This repository contains tools for working with Liquid Bitcoin (LBTC) transactions. The examples demonstrate how to generate confidential addresses, fetch and unblind UTXOs, and send transactions using the Liquid network.

## Prerequisites

- [Node.js](https://nodejs.org/) (version 14 or later recommended)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/) for package management

## Setup

1. Clone the repository:
   ```bash
        git clone git@github.com:Faisal-3389/liquid-poc.git
        cd liquid-poc
   ```

2.	Install Dependencies:
    ```bash
        npm install
    ```

3.	Run Example 1:
    ```bash
        node example-1.js
    ```
---

## Example 1: Sending LBTC (`example-1.js`)

### Description

The script to:
1. Generate a new Liquid confidential address.
2. Fetch UTXOs associated with the generated address.
3. Unblind the UTXOs using the blinding key.
4. Create and sign a transaction to send LBTC to a specified recipient.

---

Running the following commands results in errors:

1. **Command:** node example-1.js
   - **Description:** This runs with the first amount I was trying.
   - **Error Returned:** sendrawtransaction RPC error -26: dust

2. **Command:** node example-2.js
   - **Description:** This runs with the second address with higher sats transaction amounts.
   - **Error Returned:** sendrawtransaction RPC error -26: bad-txns-in-ne-out, value in != value out
