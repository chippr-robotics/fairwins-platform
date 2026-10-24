const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Spec 030 (US1/US4, pillar A) — StandardDAOFactory.
 *
 * Creation of a STANDARD DAO: an OpenZeppelin 5.4.0 `Governor` + `TimelockController` (+ optionally a
 * fresh `ERC20Votes`), deployed in one transaction as IMMUTABLE instances the factory has no authority
 * over afterwards. Per the 2026-08-30 amendment (issue #1268) this contract is Cancun-only: the OZ
 * Governor closure reaches `utils/Bytes.sol`, which uses `mcopy`. ETC 61 / Mordor 63 are excluded by
 * decision — pillar B's paris-safe `ExternalDAORegistry` keeps serving every chain.
 *
 * The role-hygiene assertions are the security core of this file: a factory that keeps
 * `DEFAULT_ADMIN_ROLE` on a member's timelock owns their treasury.
 */

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };

const DAY = 24 * 60 * 60;

/** Params that are valid on every path; individual tests override one field at a time. */
function baseParams(over = {}) {
  return {
    name: "Test DAO",
    purpose: "Fund public goods",
    votesToken: ethers.ZeroAddress,
    tokenName: "Test DAO Token",
    tokenSymbol: "TDAO",
    initialSupply: ethers.parseEther("1000"),
    votingDelay: 1,
    votingPeriod: 20,
    proposalThreshold: 0,
    quorumPercent: 4,
    timelockDelay: DAY,
    ...over,
  };
}

describe("StandardDAOFactory (spec 030 / US1 + US4, pillar A)", () => {
  let owner, creator, voter, outsider, sanctioned;
  let membership, sanctions, factory;

  beforeEach(async () => {
    [owner, creator, voter, outsider, sanctioned] = await ethers.getSigners();

    const Membership = await ethers.getContractFactory("MockMembershipTier");
    membership = await Membership.deploy();
    await membership.waitForDeployment();
    await membership.setTier(creator.address, Tier.Silver);
    await membership.setTier(voter.address, Tier.Silver);
    await membership.setTier(sanctioned.address, Tier.Gold);
    await membership.setTier(outsider.address, Tier.Bronze); // sub-tier

    const Sanctions = await ethers.getContractFactory("MockPoolSanctions");
    sanctions = await Sanctions.deploy();
    await sanctions.waitForDeployment();
    await sanctions.setDenied(sanctioned.address, true);

    const TimelockDeployer = await ethers.getContractFactory("StandardDAOTimelockDeployer");
    const timelockDeployer = await TimelockDeployer.deploy();
    await timelockDeployer.waitForDeployment();
    const TokenDeployer = await ethers.getContractFactory("StandardDAOTokenDeployer");
    const tokenDeployer = await TokenDeployer.deploy();
    await tokenDeployer.waitForDeployment();
    const GovernorDeployer = await ethers.getContractFactory("StandardDAOGovernorDeployer");
    const governorDeployer = await GovernorDeployer.deploy();
    await governorDeployer.waitForDeployment();

    const Impl = await ethers.getContractFactory("StandardDAOFactory");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const initData = Impl.interface.encodeFunctionData("initialize", [
      owner.address,
      await membership.getAddress(),
      await sanctions.getAddress(),
      await timelockDeployer.getAddress(),
      await tokenDeployer.getAddress(),
      await governorDeployer.getAddress(),
    ]);
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();
    factory = Impl.attach(await proxy.getAddress());
  });

  /** Create a DAO as `signer` and return the three addresses from the event. */
  async function createDAO(signer, over = {}) {
    const tx = await factory.connect(signer).createDAO(baseParams(over));
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l && l.name === "StandardDAOCreated");
    expect(log, "expected a StandardDAOCreated event").to.not.equal(undefined);
    return {
      id: log.args.id,
      governor: log.args.governor,
      timelock: log.args.timelock,
      token: log.args.token,
      tokenDeployed: log.args.tokenDeployed,
    };
  }

  describe("creation", () => {
    it("deploys governor + timelock + a fresh votes token and records the DAO", async () => {
      const before = await factory.daoCount();
      const created = await createDAO(creator);

      expect(created.id).to.equal(before + 1n);
      expect(created.tokenDeployed).to.equal(true);
      for (const addr of [created.governor, created.timelock, created.token]) {
        expect(await ethers.provider.getCode(addr)).to.not.equal("0x");
      }

      expect(await factory.daoCount()).to.equal(before + 1n);
      const record = await factory.getDAO(created.id);
      expect(record.governor).to.equal(created.governor);
      expect(record.timelock).to.equal(created.timelock);
      expect(record.token).to.equal(created.token);
      expect(record.creator).to.equal(creator.address);
      expect(record.name).to.equal("Test DAO");
      expect(await factory.getDAOsByCreator(creator.address)).to.deep.equal([created.id]);
      expect(await factory.isDAO(created.governor)).to.equal(true);
    });

    it("emits the event with the shape an indexer reads", async () => {
      await expect(factory.connect(creator).createDAO(baseParams()))
        .to.emit(factory, "StandardDAOCreated")
        .withArgs(
          1n,
          creator.address,
          (g) => ethers.isAddress(g) && g !== ethers.ZeroAddress,
          (t) => ethers.isAddress(t) && t !== ethers.ZeroAddress,
          (t) => ethers.isAddress(t) && t !== ethers.ZeroAddress,
          true,
          "Test DAO",
        );
    });

    it("wires the governor to the deployed token and timelock, with the requested parameters", async () => {
      const created = await createDAO(creator, { votingDelay: 3, votingPeriod: 40, quorumPercent: 10 });
      const governor = await ethers.getContractAt("StandardDAOGovernor", created.governor);

      expect(await governor.name()).to.equal("Test DAO");
      expect(await governor.token()).to.equal(created.token);
      expect(await governor.timelock()).to.equal(created.timelock);
      expect(await governor.votingDelay()).to.equal(3n);
      expect(await governor.votingPeriod()).to.equal(40n);
      expect(await governor.quorumNumerator()).to.equal(10n);

      const timelock = await ethers.getContractAt("TimelockController", created.timelock);
      expect(await timelock.getMinDelay()).to.equal(BigInt(DAY));
    });

    it("mints the initial supply to the creator and self-delegates it, so the DAO is votable at once", async () => {
      const created = await createDAO(creator);
      const token = await ethers.getContractAt("StandardDAOToken", created.token);

      expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther("1000"));
      expect(await token.delegates(creator.address)).to.equal(creator.address);
      expect(await token.getVotes(creator.address)).to.equal(ethers.parseEther("1000"));
    });

    it("accepts an EXISTING IVotes token and deploys no token of its own", async () => {
      const Token = await ethers.getContractFactory("StandardDAOToken");
      const existing = await Token.deploy("Pre-existing", "PRE", creator.address, ethers.parseEther("500"));
      await existing.waitForDeployment();
      const existingAddr = await existing.getAddress();

      const created = await createDAO(creator, { votesToken: existingAddr, initialSupply: 0 });
      expect(created.token).to.equal(existingAddr);
      expect(created.tokenDeployed).to.equal(false);

      const governor = await ethers.getContractAt("StandardDAOGovernor", created.governor);
      expect(await governor.token()).to.equal(existingAddr);
    });
  });

  describe("validation", () => {
    it("rejects an existing-token address that is an EOA", async () => {
      await expect(
        factory.connect(creator).createDAO(baseParams({ votesToken: outsider.address })),
      ).to.be.revertedWithCustomError(factory, "NotAVotesToken");
    });

    it("rejects an existing-token address that is a contract but not IVotes", async () => {
      const NotVotes = await ethers.getContractFactory("MockNonGovernor");
      const notVotes = await NotVotes.deploy();
      await notVotes.waitForDeployment();
      await expect(
        factory.connect(creator).createDAO(baseParams({ votesToken: await notVotes.getAddress() })),
      ).to.be.revertedWithCustomError(factory, "NotAVotesToken");
    });

    it("rejects an empty DAO name", async () => {
      await expect(
        factory.connect(creator).createDAO(baseParams({ name: "" })),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });

    it("rejects a zero voting period", async () => {
      await expect(
        factory.connect(creator).createDAO(baseParams({ votingPeriod: 0 })),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });

    it("rejects a quorum outside 1..100 percent", async () => {
      await expect(
        factory.connect(creator).createDAO(baseParams({ quorumPercent: 0 })),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
      await expect(
        factory.connect(creator).createDAO(baseParams({ quorumPercent: 101 })),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });

    it("rejects a timelock delay beyond the bound", async () => {
      const max = await factory.MAX_TIMELOCK_DELAY();
      await expect(
        factory.connect(creator).createDAO(baseParams({ timelockDelay: max + 1n })),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });

    it("rejects a new-token request with no symbol", async () => {
      await expect(
        factory.connect(creator).createDAO(baseParams({ tokenSymbol: "" })),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });
  });

  describe("gating", () => {
    it("refuses a wallet below the required membership tier", async () => {
      await expect(
        factory.connect(outsider).createDAO(baseParams()),
      ).to.be.revertedWithCustomError(factory, "InsufficientMembershipTier");
      expect(await factory.daoCount()).to.equal(0n);
    });

    it("refuses a sanctioned wallet even at a sufficient tier", async () => {
      await expect(factory.connect(sanctioned).createDAO(baseParams())).to.be.reverted;
      expect(await factory.daoCount()).to.equal(0n);
    });
  });

  describe("role hygiene on the created DAO (the factory keeps nothing)", () => {
    let created, timelock;

    beforeEach(async () => {
      created = await createDAO(creator);
      timelock = await ethers.getContractAt("TimelockController", created.timelock);
    });

    it("grants PROPOSER and CANCELLER to the governor and nobody else", async () => {
      const proposer = await timelock.PROPOSER_ROLE();
      const canceller = await timelock.CANCELLER_ROLE();
      expect(await timelock.hasRole(proposer, created.governor)).to.equal(true);
      expect(await timelock.hasRole(canceller, created.governor)).to.equal(true);
      for (const who of [await factory.getAddress(), creator.address, owner.address]) {
        expect(await timelock.hasRole(proposer, who)).to.equal(false);
        expect(await timelock.hasRole(canceller, who)).to.equal(false);
      }
    });

    it("leaves execution open (address(0)) so a passed proposal can never be stranded", async () => {
      const executor = await timelock.EXECUTOR_ROLE();
      expect(await timelock.hasRole(executor, ethers.ZeroAddress)).to.equal(true);
    });

    it("renounces the timelock admin role — only the timelock itself governs its roles", async () => {
      const admin = await timelock.DEFAULT_ADMIN_ROLE();
      expect(await timelock.hasRole(admin, await factory.getAddress())).to.equal(false);
      expect(await timelock.hasRole(admin, creator.address)).to.equal(false);
      expect(await timelock.hasRole(admin, owner.address)).to.equal(false);
      // The timelock self-administers: role changes must themselves pass through governance.
      expect(await timelock.hasRole(admin, created.timelock)).to.equal(true);
    });

    it("cannot schedule on the timelock it created", async () => {
      const factoryAddr = await factory.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [factoryAddr]);
      await ethers.provider.send("hardhat_setBalance", [factoryAddr, "0x1000000000000000000"]);
      const asFactory = await ethers.getSigner(factoryAddr);
      await expect(
        timelock
          .connect(asFactory)
          .schedule(creator.address, 0, "0x", ethers.ZeroHash, ethers.ZeroHash, DAY),
      ).to.be.reverted;
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [factoryAddr]);
    });

    it("holds no funds and refuses plain value", async () => {
      await expect(
        creator.sendTransaction({ to: await factory.getAddress(), value: 1n }),
      ).to.be.reverted;
      expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(0n);
    });
  });

  describe("proposal lifecycle on a created DAO (US4: propose → vote → queue → execute)", () => {
    it("moves treasury funds exactly once through a passed proposal", async () => {
      const created = await createDAO(creator, { votingDelay: 1, votingPeriod: 20, timelockDelay: DAY });
      const governor = await ethers.getContractAt("StandardDAOGovernor", created.governor);
      const token = await ethers.getContractAt("StandardDAOToken", created.token);

      // Give the second voter weight too, so quorum does not depend on a single holder.
      await token.connect(creator).transfer(voter.address, ethers.parseEther("100"));
      await token.connect(voter).delegate(voter.address);

      // Fund the DAO treasury (the timelock) with the platform stablecoin stand-in.
      const USDC = await ethers.getContractFactory("MockERC20");
      const usdc = await USDC.deploy("USD Coin", "USDC", 0);
      await usdc.waitForDeployment();
      await usdc.mint(created.timelock, 1_000_000n);

      const targets = [await usdc.getAddress()];
      const values = [0];
      const calldatas = [usdc.interface.encodeFunctionData("transfer", [outsider.address, 250_000n])];
      const description = "Pay the grant";
      const descriptionHash = ethers.id(description);

      await mine(1);
      const proposeTx = await governor.connect(creator).propose(targets, values, calldatas, description);
      const proposeReceipt = await proposeTx.wait();
      const proposalId = governor.interface.parseLog(
        proposeReceipt.logs.find((l) => {
          try {
            return governor.interface.parseLog(l).name === "ProposalCreated";
          } catch {
            return false;
          }
        }),
      ).args.proposalId;

      // Pending → Active
      await mine(2);
      expect(await governor.state(proposalId)).to.equal(1); // Active
      await governor.connect(creator).castVote(proposalId, 1); // For
      await governor.connect(voter).castVote(proposalId, 1);

      await mine(21);
      expect(await governor.state(proposalId)).to.equal(4); // Succeeded

      await governor.queue(targets, values, calldatas, descriptionHash);
      expect(await governor.state(proposalId)).to.equal(5); // Queued

      // Executing before the timelock elapses is refused.
      await expect(governor.execute(targets, values, calldatas, descriptionHash)).to.be.reverted;

      await time.increase(DAY + 1);
      await governor.execute(targets, values, calldatas, descriptionHash);

      expect(await usdc.balanceOf(outsider.address)).to.equal(250_000n);
      expect(await usdc.balanceOf(created.timelock)).to.equal(750_000n);
      expect(await governor.state(proposalId)).to.equal(7); // Executed

      // Exactly once: a second execute of the same proposal is refused.
      await expect(governor.execute(targets, values, calldatas, descriptionHash)).to.be.reverted;
    });

    it("performs no treasury action for a defeated proposal", async () => {
      const created = await createDAO(creator, { votingDelay: 1, votingPeriod: 20 });
      const governor = await ethers.getContractAt("StandardDAOGovernor", created.governor);

      const USDC = await ethers.getContractFactory("MockERC20");
      const usdc = await USDC.deploy("USD Coin", "USDC", 0);
      await usdc.waitForDeployment();
      await usdc.mint(created.timelock, 1_000_000n);

      const targets = [await usdc.getAddress()];
      const values = [0];
      const calldatas = [usdc.interface.encodeFunctionData("transfer", [outsider.address, 250_000n])];
      const description = "Drain the treasury";
      const descriptionHash = ethers.id(description);

      await mine(1);
      const receipt = await (
        await governor.connect(creator).propose(targets, values, calldatas, description)
      ).wait();
      const proposalId = governor.interface.parseLog(
        receipt.logs.find((l) => {
          try {
            return governor.interface.parseLog(l).name === "ProposalCreated";
          } catch {
            return false;
          }
        }),
      ).args.proposalId;

      await mine(2);
      await governor.connect(creator).castVote(proposalId, 0); // Against
      await mine(21);

      expect(await governor.state(proposalId)).to.equal(3); // Defeated
      await expect(governor.queue(targets, values, calldatas, descriptionHash)).to.be.reverted;
      await expect(governor.execute(targets, values, calldatas, descriptionHash)).to.be.reverted;
      expect(await usdc.balanceOf(created.timelock)).to.equal(1_000_000n);
    });
  });

  describe("registry linkage (pillar A → pillar B)", () => {
    /*
     * The whole reason pillar A needs no governance UI of its own: a created DAO is a stock
     * `IGovernor`, so pillar B's registry — which validates by ERC-165 probe and then by IGovernor
     * views — accepts it, and every existing ClearPath surface then serves it identically to any
     * third-party Governor. If this ever stopped holding, the mini-app's "register the DAO you just
     * created" step would fail AFTER the member had paid for the creation.
     */
    it("a factory-created governor is accepted by the ExternalDAORegistry", async () => {
      const created = await createDAO(creator);

      const RegImpl = await ethers.getContractFactory("ExternalDAORegistry");
      const regImpl = await RegImpl.deploy();
      await regImpl.waitForDeployment();
      const initData = RegImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await membership.getAddress(),
      ]);
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const regProxy = await Proxy.deploy(await regImpl.getAddress(), initData);
      await regProxy.waitForDeployment();
      const registry = RegImpl.attach(await regProxy.getAddress());

      await expect(registry.connect(creator).registerExternalDAO(created.governor, 0, "Test DAO"))
        .to.emit(registry, "ExternalDAORegistered")
        .withArgs(1n, created.governor, 0, creator.address, "Test DAO");
      expect(await registry.isRegistered(created.governor)).to.equal(true);
    });

    it("answers both probes the registry falls back through", async () => {
      const created = await createDAO(creator);
      const governor = await ethers.getContractAt("StandardDAOGovernor", created.governor);
      // Primary probe: ERC-165 itself must answer, or the registry's `try` leg is meaningless.
      expect(await governor.supportsInterface("0x01ffc9a7")).to.equal(true);
      // Defensive fallback the registry uses for governors with imperfect ERC-165.
      expect(await governor.COUNTING_MODE()).to.be.a("string").and.not.equal("");
      expect(await governor.votingPeriod()).to.be.greaterThan(0n);
    });
  });

  describe("admin surface", () => {
    it("lets the admin repoint the membership + sanctions integrations, and nobody else", async () => {
      const Membership = await ethers.getContractFactory("MockMembershipTier");
      const other = await Membership.deploy();
      await other.waitForDeployment();

      await expect(factory.connect(creator).setMembershipManager(await other.getAddress())).to.be.reverted;
      await factory.connect(owner).setMembershipManager(await other.getAddress());
      expect(await factory.membershipManager()).to.equal(await other.getAddress());

      await expect(factory.connect(owner).setMembershipManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress",
      );
    });
  });
});
