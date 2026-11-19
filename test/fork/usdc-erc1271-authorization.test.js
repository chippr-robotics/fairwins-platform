/**
 * Spec 041 T015 (analysis U1) — verify the spec assumption that NATIVE USDC on
 * Polygon (Circle FiatToken v2.2) accepts an EIP-3009 `receiveWithAuthorization`
 * signed by a SMART ACCOUNT via ERC-1271 (ERC-7598 bytes-signature overload).
 *
 * This is the future payment-leg for passkey accounts on the 035 intent rails.
 * Runs only when POLYGON_RPC_URL is set (archive node recommended; pin with
 * POLYGON_FORK_BLOCK), matching the house fork-test convention.
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { AbiCoder } = require("ethers");
const { createPasskey, signAsPasskeyOwner } = require("../account/helpers/webauthn");

const abi = AbiCoder.defaultAbiCoder();

// Native (Circle-issued) USDC on Polygon PoS — NOT bridged USDC.e.
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: 137, verifyingContract: USDC };
// FiatToken v2.x `balances` mapping slot (used to seed the account via hardhat_setStorageAt).
const USDC_BALANCES_SLOT = 9n;

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const describeFork = process.env.POLYGON_RPC_URL ? describe : describe.skip;

describeFork("Native USDC accepts smart-account (ERC-1271) EIP-3009 authorizations [fork]", function () {
  this.timeout(180_000);

  before(async function () {
    const blockTag = process.env.POLYGON_FORK_BLOCK
      ? { blockNumber: parseInt(process.env.POLYGON_FORK_BLOCK, 10) }
      : {};
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: process.env.POLYGON_RPC_URL, ...blockTag } }],
    });
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("pulls USDC from a passkey smart account through receiveWithAuthorization(bytes)", async function () {
    const [deployer] = await ethers.getSigners();

    // Deploy the vendored stack + a passkey-owned account on the fork.
    const Wallet = await ethers.getContractFactory("CoinbaseSmartWallet");
    const impl = await Wallet.deploy();
    const Factory = await ethers.getContractFactory("CoinbaseSmartWalletFactory");
    const factory = await Factory.deploy(await impl.getAddress());
    const passkey = createPasskey();
    const owners = [passkey.ownerBytes];
    await factory.createAccount(owners, 0);
    const account = Wallet.attach(await factory["getAddress(bytes[],uint256)"](owners, 0));
    const accountAddr = await account.getAddress();

    // Seed the account with USDC directly in FiatToken storage.
    const value = 25_000_000n; // 25 USDC
    const balSlot = ethers.keccak256(abi.encode(["address", "uint256"], [accountAddr, USDC_BALANCES_SLOT]));
    await network.provider.send("hardhat_setStorageAt", [USDC, balSlot, ethers.toBeHex(value, 32)]);
    const usdc = await ethers.getContractAt("IERC20", USDC);
    expect(await usdc.balanceOf(accountAddr)).to.equal(value);

    const Receiver = await ethers.getContractFactory("MockAuthReceiver");
    const receiver = await Receiver.deploy();
    const receiverAddr = await receiver.getAddress();

    // Sign the EIP-3009 authorization AS THE ACCOUNT: EIP-712 digest under the
    // token domain, wrapped by the account's replay-safe hash, signed by the passkey.
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const message = {
      from: accountAddr,
      to: receiverAddr,
      value,
      validAfter: 0,
      validBefore: now + 3600,
      nonce,
    };
    const digest = ethers.TypedDataEncoder.hash(USDC_DOMAIN, RECEIVE_TYPES, message);
    const signature = signAsPasskeyOwner(passkey, 0, await account.replaySafeHash(digest));

    // Anyone (here: deployer, standing in for the relayer) submits; USDC verifies
    // the signature against the ACCOUNT via ERC-1271 and moves the funds.
    await receiver.connect(deployer).pull(USDC, accountAddr, value, 0, now + 3600, nonce, signature);

    expect(await usdc.balanceOf(accountAddr)).to.equal(0n);
    expect(await usdc.balanceOf(receiverAddr)).to.equal(value);
  });

  it("rejects the same authorization with a tampered value (signature binding)", async function () {
    const [deployer] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory("CoinbaseSmartWallet");
    const impl = await Wallet.deploy();
    const Factory = await ethers.getContractFactory("CoinbaseSmartWalletFactory");
    const factory = await Factory.deploy(await impl.getAddress());
    const passkey = createPasskey();
    await factory.createAccount([passkey.ownerBytes], 0);
    const account = Wallet.attach(await factory["getAddress(bytes[],uint256)"]([passkey.ownerBytes], 0));
    const accountAddr = await account.getAddress();

    const value = 10_000_000n;
    const balSlot = ethers.keccak256(abi.encode(["address", "uint256"], [accountAddr, USDC_BALANCES_SLOT]));
    await network.provider.send("hardhat_setStorageAt", [USDC, balSlot, ethers.toBeHex(value, 32)]);

    const Receiver = await ethers.getContractFactory("MockAuthReceiver");
    const receiver = await Receiver.deploy();

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const digest = ethers.TypedDataEncoder.hash(USDC_DOMAIN, RECEIVE_TYPES, {
      from: accountAddr,
      to: await receiver.getAddress(),
      value,
      validAfter: 0,
      validBefore: now + 3600,
      nonce,
    });
    const signature = signAsPasskeyOwner(passkey, 0, await account.replaySafeHash(digest));

    // ANY-REVERT: the refusal originates inside Circle's live FiatToken on the fork (a dependency we do
    // not control); its reason string is theirs to change, and the property is only that it refuses.
    await expect(
      receiver.connect(deployer).pull(USDC, accountAddr, value - 1n, 0, now + 3600, nonce, signature)
    ).to.be.reverted;
  });
});
