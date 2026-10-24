/**
 * Node-side tasks for ClearPath's native standard DAOs (spec 030 pillar A, issue #1400 §A).
 *
 * TWO TASKS, TWO TIERS, AND THEY DELIBERATELY SHARE NOTHING.
 *
 *   `clearpathDao`            — reads the LOCAL CHAIN. Used only by the on-chain tier
 *                               (`cypress/e2e/full/42-clearpath-native-dao.cy.js`), because the
 *                               claims it answers are claims about deployed contracts: who holds
 *                               the timelock's roles, what the factory recorded, and who paid the
 *                               gas. Every one of them is read back from the chain rather than
 *                               from what a dialog said, which is the only way a creation flow can
 *                               tell a working money path from a broken one.
 *
 *   `clearpathRegistryWorld`  — ABI-ENCODES a mini-app registry record and touches no chain at
 *                               all. Used only by the no-chain tier
 *                               (`cypress/e2e/fast/46-clearpath-unavailable.cy.js`), which needs a
 *                               registry answer so the real ClearPath package can be fetched,
 *                               verified and executed, and needs nothing else.
 *
 * WHY `clearpathRegistryWorld` EXISTS BESIDE `miniappCatalogWorld`. That task answers `appCount`
 * and `getAppsPaged` — everything the CATALOGUE reads. Opening `/apps/<slug>` reads something
 * else: `registryClient#fetchAppBySlug` resolves the slug through `idByName(name)` and then
 * `getApp(id)`. An unanswered read there is `0x`, which ethers rejects, and the workspace renders
 * its honest unreachable-registry refusal — so a spec that stubbed only the catalogue would be
 * measuring the refusal path rather than the app. This returns all four selectors from ONE record,
 * so the catalogue and the direct route agree by construction.
 *
 * The ABI fragments are copied from `frontend/src/abis/miniAppRegistry.js`; encoding here with the
 * app's own shape means a field added to `AppView` changes what this returns rather than producing
 * plausible garbage that decodes into the wrong columns.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ethers } from 'ethers'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** frontend/cypress/support/tasks → repository root. */
const ROOT = resolve(__dirname, '..', '..', '..', '..')

/**
 * The factory's write + read surface. Copied from
 * `frontend/miniapps/clearpath/src/standardDaoFactoryAbi.js`, which mirrors
 * `contracts/clearpath/interfaces/IStandardDAOFactory.sol` — the same source the package encodes
 * its transaction from, so a struct-field change breaks both together instead of silently
 * decoding this task's reads into the wrong columns.
 */
const FACTORY_ABI = [
  'function daoCount() view returns (uint256)',
  'function getDAO(uint256 id) view returns ((address governor, address timelock, address token, address creator, uint64 createdAt, bool tokenDeployed, string name))',
  'function getDAOsByCreator(address creator) view returns (uint256[])',
  'function isDAO(address governor) view returns (bool)',
  'event StandardDAOCreated(uint256 indexed id, address indexed creator, address indexed governor, address timelock, address token, bool tokenDeployed, string name)',
]

/**
 * The four role facts that decide whether a created DAO owns itself.
 *
 * `StandardDAOFactory._wireAndRelinquish` grants PROPOSER + CANCELLER to the governor, opens
 * EXECUTOR to `address(0)`, and renounces the factory's own admin. If that renounce were ever
 * dropped the factory would hold root over every treasury it had created — which is exactly the
 * kind of change no unit test of the mini-app could notice, so the e2e flow reads the roles.
 */
const TIMELOCK_ABI = [
  'function PROPOSER_ROLE() view returns (bytes32)',
  'function EXECUTOR_ROLE() view returns (bytes32)',
  'function CANCELLER_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function getMinDelay() view returns (uint256)',
]

const GOVERNOR_ABI = [
  'function name() view returns (string)',
  'function token() view returns (address)',
  'function timelock() view returns (address)',
  'function votingDelay() view returns (uint256)',
  'function votingPeriod() view returns (uint256)',
  'function quorumNumerator() view returns (uint256)',
]

const VOTES_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function delegates(address) view returns (address)',
]

/** Copied verbatim from frontend/src/abis/miniAppRegistry.js. */
const APP_VIEW =
  '(uint256 id, address vendor, string name, string description, uint8 category, uint8 status, bool launchable, (string cid, bytes32 manifestHash, uint64 version) approved, (string cid, bytes32 manifestHash, uint64 version) proposed, uint64 submittedAt, uint64 approvedAt, uint64 updatedAt)'

const REGISTRY_READ_ABI = [
  'function appCount() view returns (uint256)',
  `function getApp(uint256 id) view returns (${APP_VIEW})`,
  `function getAppsPaged(uint256 offset, uint256 limit) view returns (${APP_VIEW}[] apps)`,
  'function idByName(string name) view returns (uint256)',
]

export default function clearpathTasks(config) {
  const chainId = Number(config.env.NETWORK_ID)
  const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'

  const readProvider = () => new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })

  /**
   * The local deployment record — the same file `check:e2e-addresses` compares the app's
   * hardcoded block against, so the factory this task reads is the factory the app resolves.
   */
  const localDeployment = () =>
    JSON.parse(
      readFileSync(resolve(ROOT, 'deployments', `localhost-chain${chainId}-v2.json`), 'utf8'),
    )

  return {
    /**
     * Read what the chain holds about native standard DAOs.
     *
     * READ-ONLY, deliberately: creating a DAO is the flow's job, through the app, and a task that
     * could create one would let the spec pass while the member-facing path was broken. The only
     * thing this arranges is nothing at all.
     *
     * action ∈ factoryState | daoByGovernor | creationTx | nativeBalance
     */
    async clearpathDao({ action, args = {} } = {}) {
      try {
        const provider = readProvider()
        // Read lazily, and only where a factory is actually needed: an unknown action must report
        // itself as an unknown action, not as whatever happened to fail first.
        const factoryAddress = () => {
          const address = localDeployment().contracts?.standardDaoFactory
          if (!address || !ethers.isAddress(address)) {
            throw new Error(
              `no standardDaoFactory in deployments/localhost-chain${chainId}-v2.json — ` +
                'run `npm run setup:e2e` (its `deploy:local:clearpath` step deploys pillar A on this chain)',
            )
          }
          return address
        }

        switch (action) {
          /**
           * Where the factory is and how many DAOs it has recorded.
           *
           * A missing address is reported as `deployed: false` rather than thrown, because it is
           * the one failure a reader needs named precisely: `deploy:local:clearpath` deploys the
           * factory on the local chain (80002 is in its CANCUN_CHAIN_IDS), but the app reads a
           * HARDCODED constant, so the surface goes dark whenever `HARDHAT_CONTRACTS` has no
           * `standardDaoFactory` key. "Launch says not deployed" and "the factory is not deployed"
           * are different bugs with different fixes.
           */
          case 'factoryState': {
            const address = localDeployment().contracts?.standardDaoFactory
            if (!address || !ethers.isAddress(address)) {
              return { ok: true, deployed: false, address: null, count: 0 }
            }
            const factory = new ethers.Contract(address, FACTORY_ABI, provider)
            return {
              ok: true,
              deployed: true,
              address,
              count: Number(await factory.daoCount()),
            }
          }

          /**
           * Everything the chain knows about ONE created DAO, found by its governor address.
           *
           * Returns the factory's record, the governor's own view of what it is bound to, the
           * timelock's four role facts, and the token's supply and delegation. They come from
           * FOUR different contracts on purpose: the factory's record agreeing with itself proves
           * nothing, and `createDAO` already reverts when the governor disagrees with it — what is
           * left to check is that the DAO the member now owns is wired the way the surface said.
           */
          case 'daoByGovernor': {
            const address = factoryAddress()
            const factory = new ethers.Contract(address, FACTORY_ABI, provider)
            const events = await factory.queryFilter(
              factory.filters.StandardDAOCreated(null, null, args.governor),
              0,
              'latest',
            )
            if (events.length === 0) {
              return { ok: false, error: `no StandardDAOCreated event for governor ${args.governor}` }
            }
            const id = Number(events[events.length - 1].args.id)
            const record = await factory.getDAO(id)

            const governor = new ethers.Contract(record.governor, GOVERNOR_ABI, provider)
            const timelock = new ethers.Contract(record.timelock, TIMELOCK_ABI, provider)
            const token = new ethers.Contract(record.token, VOTES_ABI, provider)

            const [proposerRole, executorRole, cancellerRole, adminRole] = await Promise.all([
              timelock.PROPOSER_ROLE(),
              timelock.EXECUTOR_ROLE(),
              timelock.CANCELLER_ROLE(),
              timelock.DEFAULT_ADMIN_ROLE(),
            ])

            return {
              ok: true,
              id,
              record: {
                governor: record.governor,
                timelock: record.timelock,
                token: record.token,
                creator: record.creator,
                tokenDeployed: record.tokenDeployed,
                name: record.name,
              },
              isDAO: await factory.isDAO(record.governor),
              byCreator: (await factory.getDAOsByCreator(record.creator)).map(Number),
              governor: {
                name: await governor.name(),
                token: await governor.token(),
                timelock: await governor.timelock(),
                votingDelay: Number(await governor.votingDelay()),
                votingPeriod: Number(await governor.votingPeriod()),
                quorumNumerator: Number(await governor.quorumNumerator()),
              },
              timelock: {
                minDelay: Number(await timelock.getMinDelay()),
                // The governor proposes and may cancel; nobody else can schedule anything.
                governorIsProposer: await timelock.hasRole(proposerRole, record.governor),
                governorIsCanceller: await timelock.hasRole(cancellerRole, record.governor),
                creatorIsProposer: await timelock.hasRole(proposerRole, record.creator),
                // EXECUTOR open to address(0): anyone may execute an already-scheduled,
                // already-elapsed operation. It confers no new authority and removes a way to
                // strand a passed proposal.
                executorIsOpen: await timelock.hasRole(executorRole, ethers.ZeroAddress),
                // The renounce. If either of these is true the platform kept a key over a
                // member's treasury.
                factoryIsAdmin: await timelock.hasRole(adminRole, address),
                creatorIsAdmin: await timelock.hasRole(adminRole, record.creator),
                // …and the timelock administers itself, so changing any of the above is a
                // governance proposal like any other.
                selfIsAdmin: await timelock.hasRole(adminRole, record.timelock),
              },
              token: {
                name: await token.name(),
                symbol: await token.symbol(),
                totalSupply: (await token.totalSupply()).toString(),
                creatorBalance: (await token.balanceOf(record.creator)).toString(),
                creatorDelegate: await token.delegates(record.creator),
              },
            }
          }

          /**
           * The transaction that created a DAO, as the chain recorded it.
           *
           * `from` and `fee` are the whole point: creation is NOT gasless and has no relayer and
           * no paymaster on this path, so the account that signed is the account that paid. A
           * sponsored rail would show some other `from`, and a fee of zero would show a chain
           * that charged nobody — both are things this returns rather than infers.
           */
          case 'creationTx': {
            const factory = new ethers.Contract(factoryAddress(), FACTORY_ABI, provider)
            const events = await factory.queryFilter(
              factory.filters.StandardDAOCreated(null, null, args.governor),
              0,
              'latest',
            )
            if (events.length === 0) {
              return { ok: false, error: `no StandardDAOCreated event for governor ${args.governor}` }
            }
            const hash = events[events.length - 1].transactionHash
            const [tx, receipt] = await Promise.all([
              provider.getTransaction(hash),
              provider.getTransactionReceipt(hash),
            ])
            return {
              ok: true,
              hash,
              from: tx.from,
              to: tx.to,
              value: tx.value.toString(),
              gasUsed: receipt.gasUsed.toString(),
              effectiveGasPrice: receipt.gasPrice.toString(),
              fee: (receipt.gasUsed * receipt.gasPrice).toString(),
              status: Number(receipt.status),
              blockNumber: receipt.blockNumber,
            }
          }

          /**
           * A native balance, as a decimal string.
           *
           * Read through the node rather than through the app's mock: the mock answers a fixed
           * 100 ETH for every address unless `realBalances` is set, and a fabricated balance
           * cannot be used to prove that anybody paid anything.
           */
          case 'nativeBalance': {
            return {
              ok: true,
              address: args.address,
              wei: (await provider.getBalance(args.address)).toString(),
            }
          }

          default:
            throw new Error(`clearpathDao: unknown action '${action}'`)
        }
      } catch (e) {
        return { ok: false, error: e.shortMessage || e.reason || e.message }
      }
    },

    /**
     * One mini-app registry record, ABI-encoded — the no-chain tier's registry.
     *
     * Answers keyed by SELECTOR so the spec can dispatch on `params[0].data.slice(0, 10)` without
     * knowing how any of the four reads is encoded. `idByName` answers the same id whatever name
     * it is asked about, which is correct for a world holding ONE app: `fetchAppBySlug` tries
     * several spellings of a slug and then verifies `appSlug(record.name) === slug` itself, so a
     * wrong answer is still caught by the app rather than by this fixture.
     *
     * Anything not listed stays unanswered on purpose: `0x` makes ethers reject the decode, and
     * every caller turns that into an honest unreachable-registry state rather than a fabrication.
     */
    clearpathRegistryWorld({
      id = 1,
      name = 'ClearPath',
      cid,
      manifestHash,
      version = 1,
      category = 3,
      vendor = '0x00000000000000000000000000000000000000a1',
      status = 1, // Approved
      launchable = true,
    } = {}) {
      if (!cid || !manifestHash) {
        return {
          ok: false,
          error:
            'clearpathRegistryWorld needs the cid and manifestHash of the package the gateway will ' +
            'serve — otherwise the loader is verifying bytes against a hash nothing produced.',
        }
      }
      const iface = new ethers.Interface(REGISTRY_READ_ABI)
      // Fixed: nothing about a curation record may depend on the clock.
      const now = BigInt(Math.floor(Date.UTC(2026, 0, 1) / 1000))
      const row = [
        BigInt(id),
        vendor,
        name,
        `${name} — a curated mini-app.`,
        category,
        status,
        launchable,
        [cid, manifestHash, BigInt(version)],
        ['', `0x${'00'.repeat(32)}`, 0n],
        now,
        now,
        now,
      ]
      return {
        ok: true,
        id,
        answers: {
          [iface.getFunction('appCount').selector]: iface.encodeFunctionResult('appCount', [1]),
          [iface.getFunction('idByName').selector]: iface.encodeFunctionResult('idByName', [id]),
          [iface.getFunction('getApp').selector]: iface.encodeFunctionResult('getApp', [row]),
          [iface.getFunction('getAppsPaged').selector]: iface.encodeFunctionResult('getAppsPaged', [[row]]),
        },
      }
    },
  }
}
