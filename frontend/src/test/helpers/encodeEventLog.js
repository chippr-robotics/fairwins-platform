import { encodeAbiParameters, encodeEventTopics } from 'viem'

/**
 * Build a raw `{ topics, data }` log from an ABI event and its arguments IN ABI ORDER — the one
 * thing ethers' `Interface.encodeEventLog` did that viem has no single call for (spec 110, #1592).
 *
 * viem splits the job because the two halves really are different: indexed parameters become
 * topics (`encodeEventTopics`) and the rest become the data word list (`encodeAbiParameters`). This
 * helper only re-joins them, so a fixture can keep being written as the flat argument list the
 * event declares — which is how a reader checks it against the Solidity.
 *
 * It exists in ONE place on purpose. The alternative was keeping an ethers `Interface` alive in
 * three test files to build fixtures for modules that no longer use ethers, which would have put a
 * new line on the import ratchet — the list that is only ever allowed to shrink.
 *
 * @param {Array} abi        a parsed (viem/abitype) ABI containing the event
 * @param {string} eventName
 * @param {Array} values     every parameter, indexed and not, in the order the event declares them
 * @returns {{ topics: string[], data: string }}
 */
export function encodeEventLog(abi, eventName, values) {
  const item = abi.find((i) => i?.type === 'event' && i.name === eventName)
  if (!item) throw new Error(`encodeEventLog: no event "${eventName}" in this ABI`)
  if (values.length !== item.inputs.length) {
    throw new Error(
      `encodeEventLog: ${eventName} declares ${item.inputs.length} parameters, got ${values.length}`,
    )
  }
  const indexed = []
  const dataInputs = []
  const dataValues = []
  item.inputs.forEach((input, i) => {
    if (input.indexed) indexed.push(values[i])
    else {
      dataInputs.push(input)
      dataValues.push(values[i])
    }
  })
  return {
    topics: encodeEventTopics({ abi, eventName, args: indexed }),
    data: encodeAbiParameters(dataInputs, dataValues),
  }
}
