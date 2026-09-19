/**
 * `getLogsRange` — a bounded log scan that survives a provider's range cap (spec 110 T028).
 *
 * WHY THIS MOVED. It lived in `lib/clearpath/connectors/ozGovernor.js`, a DAO-framework connector,
 * and two already-converted host hooks — `useMembershipTreasuryStats` and
 * `useCallsignRegistryMetrics` — reached into that connector to get it. Neither has anything to do
 * with governance; they scan the MembershipManager and the CallsignRegistry. The function itself
 * has no governance in it and never had any ethers in it either: it is pure recursion over a
 * reader's `getLogs`.
 *
 * So the dependency was upside down — the host reaching into a mini-app-adjacent connector for a
 * chain utility — and the conversion is what made it visible. Moving it is not tidying: while it
 * sat there, taking `ozGovernor.js` off ethers would have meant touching a module two unrelated
 * hooks depend on, for reasons that have nothing to do with either of them.
 *
 * THE READER IS A DUCK TYPE, on purpose. It needs one method, `getLogs({address, topics, fromBlock,
 * toBlock})`, which both an ethers provider and `lib/chains/eventScan.js`'s handle satisfy — which
 * is exactly why the converted hooks could keep calling it unchanged. Do not narrow it to a
 * chainId: the callers already hold the reader they mean, and several of them (spec 071 estate
 * reads) choose it for reasons a chainId cannot express.
 *
 * WHAT IT DOES NOT DO is bound the range. `from`/`to` come from the caller, and every caller here
 * walks a fixed backward window in CHUNKs — never from genesis, because public RPCs reject a wide
 * `eth_getLogs` and because a scan from block 0 is the defect T012a is still open for. This only
 * handles the other half: a provider that rejects a range it considers too wide gets that range
 * halved until it accepts or `minSpan` is reached, at which point the error is real and propagates.
 */

/**
 * @param {{getLogs: (filter: object) => Promise<Array>}} reader
 * @param {string} address contract whose logs to read
 * @param {number} from inclusive start block
 * @param {number} to inclusive end block
 * @param {number} [minSpan] stop bisecting at this width and let the error through — below it the
 *   provider is not complaining about the range, so halving again would only hide the real failure
 * @param {Array} [topics] topic filter; `[]` means every event from `address`
 * @returns {Promise<Array>}
 */
export async function getLogsRange(reader, address, from, to, minSpan = 2000, topics = []) {
  try {
    return await reader.getLogs({ address, topics, fromBlock: from, toBlock: to })
  } catch (e) {
    if (to - from + 1 <= minSpan) throw e
    const mid = Math.floor((from + to) / 2)
    const left = await getLogsRange(reader, address, from, mid, minSpan, topics)
    const right = await getLogsRange(reader, address, mid + 1, to, minSpan, topics)
    return [...left, ...right]
  }
}
