import { CID } from 'multiformats'
import * as uint8arrays from 'uint8arrays'
import IpldStore from '../blockstore/ipld-store'
import { sha256 } from '@adxp/crypto'

import z from 'zod'
import { schema } from '../common/types'
import * as check from '../common/check'

const leafPointer = z.tuple([z.string(), schema.cid])
const treePointer = schema.cid
const treeEntry = z.union([leafPointer, treePointer])
const nodeSchema = z.array(treeEntry)

type LeafPointer = z.infer<typeof leafPointer>
type TreePointer = z.infer<typeof treePointer>
type TreeEntry = z.infer<typeof treeEntry>
type Node = z.infer<typeof nodeSchema>

export const leadingZerosOnHash = async (key: string): Promise<number> => {
  const hash = await sha256(key)
  const b32 = uint8arrays.toString(hash, 'base32')
  let count = 0
  for (const char of b32) {
    if (char === 'a') {
      // 'a' is 0 in b32
      count++
    } else {
      break
    }
  }
  return count
}

const spliceIn = <T>(array: T[], item: T, index: number): T[] => {
  return [...array.slice(0, index), item, ...array.slice(index)]
}

export class MST {
  blockstore: IpldStore
  cid: CID
  node: Node
  zeros: number

  constructor(blockstore: IpldStore, cid: CID, node: Node, zeros: number) {
    this.blockstore = blockstore
    this.cid = cid
    this.node = node
    this.zeros = zeros
  }

  static async create(blockstore: IpldStore, zeros = 0): Promise<MST> {
    return MST.fromData(blockstore, [], zeros)
  }

  static async fromData(
    blockstore: IpldStore,
    node: Node,
    zeros: number,
  ): Promise<MST> {
    const cid = await blockstore.put(node as any)
    return new MST(blockstore, cid, node, zeros)
  }

  static async load(
    blockstore: IpldStore,
    cid: CID,
    zeros?: number,
  ): Promise<MST> {
    const node = await blockstore.get(cid, nodeSchema)
    if (zeros === undefined) {
      const firstLeaf = node.find((entry) => check.is(entry, leafPointer))
      if (!firstLeaf) {
        throw new Error('not a valid mst node: no leaves')
      }
      zeros = await leadingZerosOnHash(firstLeaf[0])
    }
    return new MST(blockstore, cid, node, zeros)
  }

  async put(): Promise<CID> {
    this.cid = await this.blockstore.put(this.node as any) // @TODO no any
    return this.cid
  }

  async add(key: string, value: CID): Promise<CID> {
    const keyZeros = await leadingZerosOnHash(key)
    if (keyZeros === this.zeros) {
      // it belongs in this layer
      const index = this.findGtOrEqualLeafIndex(key)
      const found = this.node[index]
      if (found && found[0] === key) {
        throw new Error(`There is already a value at key: ${key}`)
      }
      const prevNode = this.node[index - 1]
      if (!prevNode || check.is(prevNode, leafPointer)) {
        // if entry before is a leaf, (or we're on far left) we can just splice in
        this.node = spliceIn(this.node, [key, value], index)
        return this.put()
      } else {
        // else we need to investigate the subtree
        const subTree = await MST.load(
          this.blockstore,
          prevNode,
          this.zeros - 1,
        )
        // we try to split the subtree around the key
        const splitSubTree = await subTree.splitAround(key)
        const newNode = this.node.slice(0, index - 1)
        if (splitSubTree[0]) newNode.push(splitSubTree[0])
        newNode.push([key, value])
        if (splitSubTree[1]) newNode.push(splitSubTree[1])
        newNode.push(...this.node.slice(index))
        this.node = newNode
        return this.put()
      }
    } else if (keyZeros < this.zeros) {
      // it belongs on a lower layer
      const index = this.findGtOrEqualLeafIndex(key)
      const prevNode = this.node[index - 1]
      if (check.is(prevNode, treePointer)) {
        // if entry before is a tree, we add it to that tree
        const subTree = await MST.load(
          this.blockstore,
          prevNode,
          this.zeros - 1,
        )
        const newSubTreeCid = await subTree.add(key, value)
        this.node[index - 1] = newSubTreeCid
        return this.put()
      } else {
        // else we need to create the subtree for it to go in
        const subTree = await MST.create(this.blockstore, this.zeros - 1)
        const newSubTreeCid = await subTree.add(key, value)
        this.node = spliceIn(this.node, newSubTreeCid, index)
        return this.put()
      }
    } else {
      // it belongs on a higher layer & we must push the rest of the tree down
      let split = await this.splitAround(key)
      // if the newly added key has >=2 more leading zeros than the current highest layer
      // then we need to add in structural nodes in between as well
      let left: CID | null = split[0]
      let right: CID | null = split[1]
      const extraLayersToAdd = keyZeros - this.zeros
      // intentionally starting at 1, since first layer is taken care of by split
      for (let i = 1; i < extraLayersToAdd; i++) {
        if (left !== null) {
          const leftNode = await MST.fromData(
            this.blockstore,
            [left],
            this.zeros + i,
          )
          left = leftNode.cid
        }
        if (right !== null) {
          const rightNode = await MST.fromData(
            this.blockstore,
            [right],
            this.zeros + i,
          )
          right = rightNode.cid
        }
      }
      let newNode: Node = []
      if (left) newNode.push(left)
      newNode.push([key, value])
      if (right) newNode.push(right)
      this.node = newNode
      this.zeros = keyZeros
      return this.put()
    }
  }

  // finds first leaf node that is greater than or equal to the value
  findGtOrEqualLeafIndex(key: string): number {
    const maybeIndex = this.node.findIndex(
      (entry) => check.is(entry, leafPointer) && entry[0] >= key,
    )
    // if we can't find, we're on the end
    return maybeIndex >= 0 ? maybeIndex : this.node.length
  }

  async splitAround(key: string): Promise<[CID | null, CID | null]> {
    const index = this.findGtOrEqualLeafIndex(key)
    const leftData = this.node.slice(0, index)
    const rightData = this.node.slice(index)

    if (leftData.length === 0) {
      return [null, this.cid]
    }
    if (rightData.length === 0) {
      return [this.cid, null]
    }
    const left = await MST.fromData(this.blockstore, leftData, this.zeros)
    const right = await MST.fromData(this.blockstore, rightData, this.zeros)
    const prev = leftData[leftData.length - 1]
    if (check.is(prev, treePointer)) {
      const prevSubtree = await MST.load(this.blockstore, prev, this.zeros - 1)
      const prevSplit = await prevSubtree.splitAround(key)
      if (prevSplit[0]) {
        await left.append(prev)
      }
      if (prevSplit[1]) {
        await right.prepend(prev)
      }
    }

    return [left.cid, right.cid]
  }

  async append(entry: TreeEntry): Promise<CID> {
    this.node = [...this.node, entry]
    return this.put()
  }

  async prepend(entry: TreeEntry): Promise<CID> {
    this.node = [entry, ...this.node]
    return this.put()
  }

  async get(key: string): Promise<CID | null> {
    const index = this.findGtOrEqualLeafIndex(key)
    const found = this.node[index]
    if (found && check.is(found, leafPointer) && found[0] === key) {
      return found[1]
    }
    const prev = this.node[index - 1]
    if (check.is(prev, treePointer)) {
      const subTree = await MST.load(this.blockstore, prev, this.zeros - 1)
      return subTree.get(key)
    }
    return null
  }

  async edit(key: string, value: CID): Promise<CID> {
    const index = this.findGtOrEqualLeafIndex(key)
    const found = this.node[index]
    if (found && check.is(found, leafPointer) && found[0] === key) {
      this.node[index][1] = value
      return await this.put()
    }
    const prev = this.node[index - 1]
    if (check.is(prev, treePointer)) {
      const subTree = await MST.load(this.blockstore, prev, this.zeros - 1)
      const subTreeCid = await subTree.edit(key, value)
      this.node[index - 1] = subTreeCid
      return await this.put()
    }
    throw new Error(`Could not find a record with key: ${key}`)
  }

  // async delete(key: string): Promise<void> {}

  layerHasEntry(entry: TreeEntry): boolean {
    let found: TreeEntry | undefined
    if (check.is(entry, leafPointer)) {
      found = this.node.find((e) => {
        return (
          check.is(e, leafPointer) && entry[0] === e[0] && entry[1].equals(e[1])
        )
      })
    } else {
      found = this.node.find((e) => {
        return check.is(e, treePointer) && entry.equals(e)
      })
    }
    return found !== undefined
  }

  // toMerge wins on merge conflicts
  async mergeIn(toMerge: MST): Promise<CID> {
    let lastIndex = 0
    for (const entry of toMerge.node) {
      if (check.is(entry, leafPointer)) {
        lastIndex = this.findGtOrEqualLeafIndex(entry[0])
        const found = this.node[lastIndex]
        if (found && found[0] === entry[0]) {
          // does nothing if same, overwrites if different
          this.node[lastIndex] = entry
          lastIndex++
        } else {
          this.node = spliceIn(this.node, entry, lastIndex)
          lastIndex++
        }
      } else {
        const nextEntryInNode = this.node[lastIndex]
        if (!check.is(nextEntryInNode, treePointer)) {
          // if the next is a leaf, we splice in before
          this.node = spliceIn(this.node, entry, lastIndex)
          lastIndex++
        } else if (!nextEntryInNode.equals(entry)) {
          // if it's a new subtree, then we have to merge the two children
          const nodeChild = await MST.load(
            this.blockstore,
            nextEntryInNode,
            this.zeros - 1,
          )
          const toMergeChild = await MST.load(
            this.blockstore,
            entry,
            this.zeros - 1,
          )
          const mergedCid = await nodeChild.mergeIn(toMergeChild)
          this.node[lastIndex] = mergedCid
          lastIndex++
        } else {
          // if it's the same subtree, do nothing & increment index
          lastIndex++
        }
      }
    }
    return this.put()
  }

  async walk(fn: (level: number, key: string | null) => void) {
    for (const entry of this.node) {
      if (check.is(entry, treePointer)) {
        const subTree = await MST.load(this.blockstore, entry, this.zeros - 1)
        fn(this.zeros, null)
        await subTree.walk(fn)
      } else {
        fn(this.zeros, entry[0])
      }
    }
  }

  async structure() {
    const tree: any = []
    for (const entry of this.node) {
      if (check.is(entry, treePointer)) {
        const subTree = await MST.load(this.blockstore, entry, this.zeros - 1)
        tree.push(['LINK', await subTree.structure()])
      } else {
        tree.push([entry[0], entry[1].toString()])
      }
    }
    return tree
  }
}

export default MST
