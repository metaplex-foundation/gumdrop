import { Keypair, PublicKey } from '@solana/web3.js';
import {
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  GUMDROP_DISTRIBUTOR_ID,
} from './constants';
import * as anchor from '@project-serum/anchor';
import log from 'loglevel';

export const getMetadata = async (
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

export const getMasterEdition = async (
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
        Buffer.from('edition'),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

export const getEditionMarkPda = async (
  mint: anchor.web3.PublicKey,
  edition: number,
): Promise<anchor.web3.PublicKey> => {
  const editionNumber = Math.floor(edition / 248);
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
        Buffer.from('edition'),
        Buffer.from(editionNumber.toString()),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];
};

export const getTokenWallet = async function (
  wallet: PublicKey,
  mint: PublicKey,
) {
  return (
    await PublicKey.findProgramAddress(
      [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    )
  )[0];
};

export async function loadGumdropProgram(
  walletKeyPair: Keypair,
  env: string,
  customRpcUrl?: string,
) {
  if (customRpcUrl) console.log('USING CUSTOM URL', customRpcUrl);

  // @ts-ignore
  const solConnection = new anchor.web3.Connection(
    //@ts-ignore
    customRpcUrl || getCluster(env),
  );

  const walletWrapper = new anchor.Wallet(walletKeyPair);
  const provider = new anchor.Provider(solConnection, walletWrapper, {
    preflightCommitment: 'recent',
  });
  const idl = await anchor.Program.fetchIdl(GUMDROP_DISTRIBUTOR_ID, provider);
  const program = new anchor.Program(idl, GUMDROP_DISTRIBUTOR_ID, provider);
  log.debug('program id from anchor', program.programId.toBase58());
  return program;
}

export const getBalance = async (
  account: anchor.web3.PublicKey,
  env: string,
  customRpcUrl?: string,
): Promise<number> => {
  if (customRpcUrl) console.log('USING CUSTOM URL', customRpcUrl);
  const connection = new anchor.web3.Connection(
    //@ts-ignore
    customRpcUrl || getCluster(env),
  );
  return await connection.getBalance(account);
};
