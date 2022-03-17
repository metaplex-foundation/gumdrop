import { keccak_256 } from 'js-sha3';

export class MerkleTree {
  static nodeHash(hashFlags: number, data: Buffer): Buffer {
    return Buffer.from(keccak_256.digest([hashFlags, ...data]));
  }

  static internalHash(first: Buffer, second: Buffer | undefined): Buffer {
    if (!second) return first;
    const [fst, snd] = [first, second].sort(Buffer.compare);
    return Buffer.from(keccak_256.digest([0x01, ...fst, ...snd]));
  }

  static verifyClaim(
    hashFlags: number,
    leaf: Buffer,
    proof: Buffer[],
    root: Buffer,
  ): boolean {
    let pair = MerkleTree.nodeHash(hashFlags, leaf);
    for (const item of proof) {
      pair = MerkleTree.internalHash(pair, item);
    }

    return pair.equals(root);
  }
}
