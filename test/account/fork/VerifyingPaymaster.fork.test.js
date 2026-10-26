const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// Spec 050 — fork test (T007): prove FairWinsVerifyingPaymaster is accepted by the REAL EntryPoint
// v0.6 on Polygon and actually pays from its deposit. Gated on POLYGON_RPC_URL (house convention:
// set it to the working publicnode endpoint). A MockAccount stands in for the WebAuthn Coinbase
// account so we don't need a P-256 signature — the point is the paymaster ↔ EntryPoint interaction.

const ENTRYPOINT_V06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const EP_ABI = [
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "function depositTo(address account) payable",
  "function balanceOf(address account) view returns (uint256)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
];

const describeFork = process.env.POLYGON_RPC_URL ? describe : describe.skip;

describeFork("FairWinsVerifyingPaymaster against real EntryPoint v0.6 [fork]", function () {
  this.timeout(180000);
  let deployer, signerWallet, paymaster, account, entryPoint, pmAddr;

  before(async function () {
    const blockTag = process.env.POLYGON_FORK_BLOCK ? { blockNumber: parseInt(process.env.POLYGON_FORK_BLOCK, 10) } : {};
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: process.env.POLYGON_RPC_URL, ...blockTag } }],
    });

    [deployer] = await ethers.getSigners();
    signerWallet = ethers.Wallet.createRandom(); // stands in for the KMS verifyingSigner

    const PM = await ethers.getContractFactory("FairWinsVerifyingPaymaster");
    paymaster = await PM.deploy(ENTRYPOINT_V06, signerWallet.address, deployer.address);
    await paymaster.waitForDeployment();
    pmAddr = await paymaster.getAddress();

    const Acct = await ethers.getContractFactory("MockAccount");
    account = await Acct.deploy();
    await account.waitForDeployment();

    entryPoint = new ethers.Contract(ENTRYPOINT_V06, EP_ABI, deployer);
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("the real EntryPoint accepts the sponsorship and pays gas from the paymaster deposit", async function () {
    // Fund the sponsorship deposit generously: v0.6 counts verificationGasLimit 3× when a paymaster
    // is present, so requiredPrefund = (callGasLimit + 3·verificationGasLimit + preVerificationGas) ×
    // maxFeePerGas — several ETH-equivalent at Polygon gas.
    await (await paymaster.connect(deployer).deposit({ value: ethers.parseEther("10") })).wait();
    const depositBefore = await entryPoint.balanceOf(pmAddr);

    const acctAddr = await account.getAddress();
    const nonce = await entryPoint.getNonce(acctAddr, 0);
    const fee = await ethers.provider.getFeeData();
    const maxFeePerGas = (fee.maxFeePerGas ?? fee.gasPrice) * 2n;
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? ethers.parseUnits("30", "gwei");

    const userOp = {
      sender: acctAddr,
      nonce,
      initCode: "0x",
      callData: account.interface.encodeFunctionData("noop"),
      callGasLimit: 200000n,
      verificationGasLimit: 500000n,
      preVerificationGas: 150000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData: "0x",
      signature: "0x",
    };

    const validUntil = 4_000_000_000; // far future
    const validAfter = 0;
    const hash = await paymaster.getHash(userOp, validUntil, validAfter);
    const sig = await signerWallet.signMessage(ethers.getBytes(hash));
    userOp.paymasterAndData = ethers.solidityPacked(
      ["address", "uint48", "uint48", "bytes"],
      [pmAddr, validUntil, validAfter, sig]
    );

    // native balances that MUST NOT change (the account holds nothing; FairWins sponsors)
    const acctBalBefore = await ethers.provider.getBalance(acctAddr);

    const tx = await entryPoint.handleOps([userOp], deployer.address);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    // the account ran its no-op (op executed)
    const ran = receipt.logs.some((l) => l.address.toLowerCase() === acctAddr.toLowerCase());
    expect(ran, "account executed the op").to.equal(true);

    // the paymaster deposit paid the gas; the account's native balance is untouched
    const depositAfter = await entryPoint.balanceOf(pmAddr);
    expect(depositAfter).to.be.lt(depositBefore);
    expect(await ethers.provider.getBalance(acctAddr)).to.equal(acctBalBefore);
  });

  it("the real EntryPoint REJECTS a sponsorship signed by the wrong key (AA34)", async function () {
    await (await paymaster.connect(deployer).deposit({ value: ethers.parseEther("10") })).wait();
    const acctAddr = await account.getAddress();
    const nonce = await entryPoint.getNonce(acctAddr, 0);
    const fee = await ethers.provider.getFeeData();

    const userOp = {
      sender: acctAddr,
      nonce,
      initCode: "0x",
      callData: account.interface.encodeFunctionData("noop"),
      callGasLimit: 200000n,
      verificationGasLimit: 500000n,
      preVerificationGas: 150000n,
      maxFeePerGas: (fee.maxFeePerGas ?? fee.gasPrice) * 2n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits("30", "gwei"),
      paymasterAndData: "0x",
      signature: "0x",
    };
    const validUntil = 4_000_000_000;
    const wrong = ethers.Wallet.createRandom();
    const hash = await paymaster.getHash(userOp, validUntil, 0);
    const sig = await wrong.signMessage(ethers.getBytes(hash)); // NOT the verifyingSigner
    userOp.paymasterAndData = ethers.solidityPacked(["address", "uint48", "uint48", "bytes"], [pmAddr, validUntil, 0, sig]);

    // EntryPoint reverts the whole bundle with an AA34 signature error for the paymaster.
    // ANY-REVERT: the revert is raised by the canonical EntryPoint v0.6 on the fork (external dependency);
    // not narrowed to FailedOp(0, "AA34 signature error") because it could not be run here without an RPC.
    await expect(entryPoint.handleOps([userOp], deployer.address)).to.be.reverted;
  });
});
