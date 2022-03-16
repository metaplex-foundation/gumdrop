import { BN } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';

export enum MetadataKey {
  Uninitialized = 0,
  MetadataV1 = 4,
  EditionV1 = 1,
  MasterEditionV1 = 2,
  MasterEditionV2 = 6,
  EditionMarker = 7,
}

export class MasterEditionV1 {
  key: MetadataKey;
  supply: BN;
  maxSupply?: BN;
  printingMint: PublicKey;
  oneTimePrintingAuthorizationMint: PublicKey;
  constructor(args: {
    key: MetadataKey;
    supply: BN;
    maxSupply?: BN;
    printingMint: PublicKey;
    oneTimePrintingAuthorizationMint: PublicKey;
  }) {
    this.key = MetadataKey.MasterEditionV1;
    this.supply = args.supply;
    this.maxSupply = args.maxSupply;
    this.printingMint = args.printingMint;
    this.oneTimePrintingAuthorizationMint =
      args.oneTimePrintingAuthorizationMint;
  }
}

export class MasterEditionV2 {
  key: MetadataKey;
  supply: BN;
  maxSupply?: BN;
  constructor(args: { key: MetadataKey; supply: BN; maxSupply?: BN }) {
    this.key = MetadataKey.MasterEditionV2;
    this.supply = args.supply;
    this.maxSupply = args.maxSupply;
  }
}

export class EditionMarker {
  key: MetadataKey;
  ledger: number[];
  constructor(args: { key: MetadataKey; ledger: number[] }) {
    this.key = MetadataKey.EditionMarker;
    this.ledger = args.ledger;
  }
}
