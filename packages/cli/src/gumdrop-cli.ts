#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import log from 'loglevel';

import {
  SESv2Client,
  CreateContactListCommand,
  GetContactCommand,
} from '@aws-sdk/client-sesv2';
import * as anchor from '@project-serum/anchor';
import * as discord from 'discord.js';
import {
  Commitment,
  Connection as RPCConnection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import * as crypto from 'crypto';

import {
  ClaimantInfo,
  Claimants,
  buildGumdrop,
  closeGumdrop,
  dropInfoFor,
  parseClaimants,
  validateTransferClaims,
  validateCandyClaims,
  validateEditionClaims,
} from './helpers/gumdrop/claimant';
import {
  AuthKeys,
  DropInfo,
  Response as DResponse,
  distributeAwsSes,
  distributeAwsSns,
  distributeManual,
  distributeWallet,
  formatDropMessage,
  urlAndHandleFor,
} from './helpers/gumdrop/communication';
import {
  GUMDROP_TEMPORAL_SIGNER,
  GUMDROP_DISTRIBUTOR_ID,
  TOKEN_METADATA_PROGRAM_ID,
} from './helpers/constants';
import { getMetadata, loadGumdropProgram } from './helpers/accounts';
import { sendSignedTransaction } from './helpers/transactions';

program.version('0.0.1');

const LOG_PATH = './.log';

if (!fs.existsSync(LOG_PATH)) {
  fs.mkdirSync(LOG_PATH);
}

log.setLevel(log.levels.INFO);

programCommand('create')
  .option(
    '--claim-integration <method>',
    'Backend for claims. Either `transfer` for token-transfers, `candy` for minting through a candy-machine, or `edition` for minting through a master edition',
  )
  .option('--transfer-mint <mint>', 'transfer: public key of mint')
  .option(
    '--delegate-only',
    'transfer and candy: delegate tokens from KEYPAIR instead of transferring to the gumdrop',
  )
  .option('--candy-machine <pubkey>', 'candy: public key of the candy machine')
  .option('--edition-mint <mint>', 'edition: mint of the master edition')
  .option(
    '--distribution-method <method>',
    // TODO: more explanation
    'Off-chain distribution of claims. Either `aws-email`, `aws-sms`, `discord`, `manual`, or `wallets`',
  )
  .option('--aws-access-key-id <string>', 'Access Key Id')
  .option('--aws-secret-access-key <string>', 'Secret Access Key')
  .option('--discord-token <string>', 'Discord bot token')
  .option(
    '--otp-auth <auth>',
    'Off-chain OTP from claim. Either `enable` for AWS OTP endpoint or `disable` to skip OTP',
  )
  .option('--distribution-list <path>', 'List of users to build gumdrop from.')
  .option(
    '--resend-only',
    'Distribute list with off-chain method only. Assumes a validator and urls already exist',
  )
  .option(
    '--host <string>',
    'Website to claim gumdrop',
    'https://gumdrop.metaplex.com/',
  )
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .action(async (options, cmd) => {
    log.info(`Parsed options:`, options);

    const wallet = loadWalletKey(options.keypair);
    const connection = new anchor.web3.Connection(
      //@ts-ignore
      'https://devnet.helius-rpc.com/?api-key=80fe76ae-0027-422f-b72c-4d160184253f', // || options.rpcUrl || anchor.web3.clusterApiUrl(options.env),
    );

    const getTemporalSigner = auth => {
      switch (auth) {
        case 'enable':
          return GUMDROP_TEMPORAL_SIGNER;
        case 'disable':
          return PublicKey.default;
        default:
          throw new Error(`Unknown OTP authorization type ${auth}`);
      }
    };

    if (!options.host) {
      throw new Error('No host website specified');
    }

    let temporalSigner;
    switch (options.distributionMethod) {
      case 'wallets':
        temporalSigner = GUMDROP_DISTRIBUTOR_ID;
        break;
      case 'manual':
      case 'aws-email':
      case 'aws-sms':
      case 'discord':
        temporalSigner = getTemporalSigner(options.otpAuth);
        break;
      default:
        throw new Error(
          "Distribution method must either be 'aws-email', 'aws-sms', 'discord', 'manual', or 'wallets'.",
        );
    }
    console.log(`temporal signer: ${temporalSigner.toBase58()}`);

    let claimantsStr;
    try {
      claimantsStr = fs.readFileSync(options.distributionList).toString();
    } catch (err) {
      throw new Error(`Could not read distribution list ${err}`);
    }
    console.log(`1`);

    const claimants = parseClaimants(
      claimantsStr,
      options.distributionList,
      options.distributionMethod,
    );
    if (claimants.length === 0) {
      throw new Error(`No claimants provided`);
    }
    console.log(`2`);

    const dropInfo = dropInfoFor(
      options.env,
      options.claimIntegration,
      options.transferMint,
      options.candyMachine,
      options.editionMint,
    );
    console.log(`3`);

    const distribute = (claimants: Claimants) => {
      switch (options.distributionMethod) {
        case 'wallets':
          return distributeWallet({}, '', claimants, dropInfo);
        case 'manual':
          return distributeManual({}, '', claimants, dropInfo);
        case 'aws-email':
          return distributeAwsSes(
            {
              accessKeyId: options.awsAccessKeyId,
              secretAccessKey: options.awsSecretAccessKey,
            },
            'santa@aws.metaplex.com',
            claimants,
            dropInfo,
          );
        case 'aws-sms':
          return distributeAwsSns(
            {
              accessKeyId: options.awsAccessKeyId,
              secretAccessKey: options.awsSecretAccessKey,
            },
            '',
            claimants,
            dropInfo,
          );
        case 'discord':
          return distributeDiscord(
            {
              botToken: options.discordToken,
            },
            '',
            claimants,
            dropInfo,
          );
      }
    };
    console.log(`4`);

    await distribute([]); // check that auth is correct...
    console.log(`5`);

    if (options.resendOnly) {
      if (claimants.some(c => typeof c.url !== 'string')) {
        throw new Error(
          "Specified resend only but not all claimants have a 'url'",
        );
      }
      const responses = await distribute(claimants);
      const respDir = fs.mkdtempSync(
        path.join(path.dirname(options.distributionList), 're-'),
      );
      const respPath = path.join(respDir, 'resp.json');
      console.log(`writing responses to ${respPath}`);
      fs.writeFileSync(respPath, JSON.stringify(responses));
      return;
    }

    const base = Keypair.generate();
    console.log(`6`, options.claimIntegration);

    let claimInfo;
    switch (options.claimIntegration) {
      case 'transfer': {
        claimInfo = await validateTransferClaims(
          connection,
          wallet.publicKey,
          claimants,
          options.transferMint,
          options.delegateOnly ? null : base.publicKey,
        );
        break;
      }
      case 'candy': {
        claimInfo = await validateCandyClaims(
          connection,
          wallet.publicKey,
          claimants,
          options.candyMachine,
          options.delegateOnly ? null : base.publicKey,
        );
        break;
      }
      case 'edition': {
        claimInfo = await validateEditionClaims(
          connection,
          wallet.publicKey,
          claimants,
          options.editionMint,
        );
        break;
      }
      default:
        throw new Error(
          "Claim integration must either be 'transfer', 'candy', or 'edition'.",
        );
    }
    console.log(`7`);

    claimants.forEach(c => {
      c.pin = new BN(randomBytes());
      c.seed =
        options.claimIntegration === 'transfer'
          ? claimInfo.mint.key
          : options.claimIntegration === 'candy'
          ? claimInfo.mint.key
          : /* === edition */ claimInfo.masterMint.key;
    });
    console.log(`8`);

    const instructions = await buildGumdrop(
      connection,
      wallet.publicKey,
      options.distributionMethod,
      options.claimIntegration,
      options.host,
      base.publicKey,
      temporalSigner,
      claimants,
      claimInfo,
    );
    console.log(`9`);

    const logDir = path.join(LOG_PATH, options.env, base.publicKey.toBase58());
    fs.mkdirSync(logDir, { recursive: true });

    const keyPath = path.join(logDir, 'id.json');
    console.log(`writing base to ${keyPath}`);
    fs.writeFileSync(keyPath, JSON.stringify([...base.secretKey]));

    const urlPath = path.join(logDir, 'urls.json');
    console.log(`writing claims to ${urlPath}`);
    fs.writeFileSync(urlPath, JSON.stringify(urlAndHandleFor(claimants)));

    const createResult = await sendTransactionWithRetry(
      connection,
      wallet,
      instructions,
      [base],
    );

    console.log(createResult);
    if (typeof createResult === 'string') {
      throw new Error(createResult);
    } else {
      console.log(
        'gumdrop creation succeeded',
        `https://explorer.solana.com/tx/${createResult.txid}?cluster=${options.env}`,
      );
    }

    console.log('distributing claim URLs');
    const responses = await distribute(claimants);
    const respPath = path.join(logDir, 'resp.json');
    console.log(`writing responses to ${respPath}`);
    fs.writeFileSync(respPath, JSON.stringify(responses));
  });

programCommand('close')
  .option(
    '--claim-integration <method>',
    'Backend for claims. Either `transfer` for token-transfers, `candy` for minting through a candy-machine, or `edition` for minting through a master edition',
  )
  .option('--transfer-mint <mint>', 'transfer: public key of mint')
  .option('--candy-machine <pubkey>', 'candy: public key of the candy machine')
  .option('--edition-mint <mint>', 'edition: mint of the master edition')
  .option('--base <path>', 'gumdrop authority generated on create')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .action(async (options, cmd) => {
    log.info(`Parsed options:`, options);

    const wallet = loadWalletKey(options.keypair);
    const base = loadWalletKey(options.base);
    const connection = new anchor.web3.Connection(
      //@ts-ignore
      options.rpcUrl || anchor.web3.clusterApiUrl(options.env),
    );

    switch (options.claimIntegration) {
      case 'transfer': {
        if (!options.transferMint) {
          throw new Error(
            "No transfer-mint provided. Used to check we're not accidentally losing ownership of other accounts",
          );
        }
        break;
      }
      case 'candy': {
        if (!options.candyMachine) {
          throw new Error(
            'No candy-machine provided. Needed to transfer back candy-machine authority',
          );
        }
        break;
      }
      case 'edition': {
        if (!options.editionMint) {
          throw new Error(
            'No master-mint provided. Needed to transfer back master',
          );
        }
        break;
      }
      default:
        throw new Error(
          "Claim integration must either be 'transfer', 'candy', or 'edition'.",
        );
    }

    const instructions = await closeGumdrop(
      connection,
      wallet.publicKey,
      base,
      options.claimIntegration,
      options.transferMint,
      options.candyMachine,
      options.editionMint,
    );

    const closeResult = await sendTransactionWithRetry(
      connection,
      wallet,
      instructions,
      [base],
    );

    console.log(closeResult);
    if (typeof closeResult === 'string') {
      throw new Error(closeResult);
    } else {
      console.log(
        'gumdrop close succeeded',
        `https://explorer.solana.com/tx/${closeResult.txid}?cluster=${options.env}`,
      );
    }
  });

programCommand('recover_update_authority')
  .option('--base <path>', 'gumdrop authority generated on create')
  .option(
    '--mint <string-pubkey>',
    'mint for metadata to recover update authority',
  )
  .option('--new-update-authority <string-pubkey>', 'new update authority')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .action(async (options, cmd) => {
    log.info(`Parsed options:`, options);

    const wallet = loadWalletKey(options.keypair);
    const base = loadWalletKey(options.base);
    const anchorProgram = await loadGumdropProgram(wallet, options.env);

    const mintKey = new PublicKey(options.mint);
    const metadataKey = await getMetadata(mintKey);
    const newUpdateAuthorityKey = new PublicKey(options.newUpdateAuthority);

    const [distributorKey, dbump] = await PublicKey.findProgramAddress(
      [Buffer.from('MerkleDistributor'), base.publicKey.toBuffer()],
      GUMDROP_DISTRIBUTOR_ID,
    );

    const [distributorWalletKey, wbump] = await PublicKey.findProgramAddress(
      [Buffer.from('Wallet'), distributorKey.toBuffer()],
      GUMDROP_DISTRIBUTOR_ID,
    );

    const recoverIx = await anchorProgram.instruction.recoverUpdateAuthority(
      dbump,
      wbump,
      {
        accounts: {
          base: base.publicKey,
          distributor: distributorKey,
          distributorWallet: distributorWalletKey,
          newUpdateAuthority: newUpdateAuthorityKey,
          metadata: metadataKey,
          systemProgram: SystemProgram.programId,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        },
      },
    );

    const recoverResult = await sendTransactionWithRetry(
      anchorProgram.provider.connection,
      wallet,
      [recoverIx],
      [base],
    );

    console.log(recoverResult);
    if (typeof recoverResult === 'string') {
      throw new Error(recoverResult);
    } else {
      console.log(
        'gumdrop recover succeeded',
        `https://explorer.solana.com/tx/${recoverResult.txid}?cluster=${options.env}`,
      );
    }
  });

programCommand('create_contact_list')
  .option('--cli-input-json <filename>')
  .option('--aws-access-key-id <string>', 'Access Key Id')
  .option('--aws-secret-access-key <string>', 'Secret Access Key')
  .addHelpText(
    'before',
    'A thin wrapper mimicking `aws sesv2 create-contact-list`',
  )
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .action(async (options, cmd) => {
    log.info(`Parsed options:`, options);

    let message;
    try {
      message = JSON.parse(fs.readFileSync(options.cliInputJson).toString());
    } catch (err) {
      throw new Error(`Could not read distribution list ${err}`);
    }

    const client = new SESv2Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: options.awsAccessKeyId,
        secretAccessKey: options.awsSecretAccessKey,
      },
    });

    try {
      const response = await client.send(new CreateContactListCommand(message));
      log.debug(response);
      if (response.$metadata.httpStatusCode !== 200) {
        //   throw new Error(`AWS SES ssemed to fail to send email: ${response[0].reject_reason}`);
      }
    } catch (err) {
      log.error(err);
    }
    log.info(`Created contact list ${message.ContactListName}`);
  });

programCommand('get_contact')
  .argument('<email>', 'email address to query')
  .option('--aws-access-key-id <string>', 'Access Key Id')
  .option('--aws-secret-access-key <string>', 'Secret Access Key')
  .addHelpText('before', 'A thin wrapper mimicking `aws sesv2 get-contact`')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  .action(async (email, options, cmd) => {
    log.info(`Parsed options:`, options);

    const client = new SESv2Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: options.awsAccessKeyId,
        secretAccessKey: options.awsSecretAccessKey,
      },
    });

    try {
      const response = await client.send(
        new GetContactCommand({
          ContactListName: 'Gumdrop',
          EmailAddress: email,
        }),
      );
      console.log(response);
    } catch (err) {
      log.error(err);
    }
  });

programCommand('fetch_program')
  .addHelpText(
    'before',
    'Utility to fetch the gumdrop program executable data. Useful for doing a diff against a local build. Bytes are formatted for easy comparison to `xxd` output',
  )
  .action(async options => {
    log.info(`Parsed options:`, options);

    const connection = new anchor.web3.Connection(
      //@ts-ignore
      options.rpcUrl || anchor.web3.clusterApiUrl(options.env),
    );

    const programPointer = await connection.getAccountInfo(
      GUMDROP_DISTRIBUTOR_ID,
    );
    const executableBufferKey = new PublicKey(programPointer.data.slice(4));

    const programBuffer = await connection.getAccountInfo(executableBufferKey);
    const programData = programBuffer.data.slice(0x30 - 3); // by inspection lol...

    for (let row = 0; row * 0x10 < programData.length; ++row) {
      let str = `${(row * 0x10).toString(16).padStart(8, '0')}: `;
      for (let chunk = 0; chunk < 8; ++chunk) {
        str += programData[row * 0x10 + chunk * 2 + 0]
          .toString(16)
          .padStart(2, '0');
        str += programData[row * 0x10 + chunk * 2 + 1]
          .toString(16)
          .padStart(2, '0');
        str += ' ';
      }
      console.log(str);
    }
  });

programCommand('check_wallets')
  .option('--distribution-list <path>', 'List of users to build gumdrop from.')
  .action(async options => {
    log.info(`Parsed options:`, options);
    if (!options.distributionList) {
      throw new Error('No distribution list found');
    }
    const l = JSON.parse(fs.readFileSync(options.distributionList).toString());
    let failed = 0;
    for (const w of l) {
      try {
        new PublicKey(w.handle);
      } catch {
        failed += 1;
        console.warn(`Bad pubkey ${w.handle}`);
      }
    }
    if (failed !== 0) {
      throw new Error(`${failed}/${l.length} bad pubkeys found`);
    } else {
      console.log(`${l.length} pubkeys seem OK`);
    }
  });

function programCommand(name: string) {
  return program
    .command(name)
    .option(
      '-e, --env <string>',
      'Solana cluster env name',
      'devnet', //mainnet-beta, testnet, devnet
    )
    .option(
      '-k, --keypair <path>',
      `Solana wallet location`,
      '--keypair not provided',
    )
    .option('-r, --rpc-url <string>', 'Custom rpc url')
    .option('-l, --log-level <string>', 'log level', setLogLevel);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setLogLevel(value, prev) {
  if (value === undefined || value === null) {
    return;
  }
  log.info('setting the log value to: ' + value);
  log.setLevel(value);
}

function loadWalletKey(keypair): Keypair {
  if (!keypair || keypair == '') {
    throw new Error('Keypair is required!');
  }
  const loaded = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString())),
  );
  log.info(`wallet public key: ${loaded.publicKey}`);
  return loaded;
}

// NB: assumes no overflow
function randomBytes(): Uint8Array {
  // TODO: some predictable seed? sha256?
  return crypto.randomBytes(4);
}

async function sendTransactionWithRetry(
  connection: RPCConnection,
  wallet: Keypair,
  instructions: Array<TransactionInstruction>,
  signers: Array<Keypair>,
  commitment: Commitment = 'singleGossip',
): Promise<string | { txid: string; slot: number }> {
  const transaction = new Transaction();
  instructions.forEach(instruction => transaction.add(instruction));
  transaction.recentBlockhash = (
    await connection.getLatestBlockhash(commitment)
  ).blockhash;

  transaction.setSigners(
    // fee payed by the wallet owner
    wallet.publicKey,
    ...signers.map(s => s.publicKey),
  );

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
  transaction.partialSign(wallet);

  return sendSignedTransaction({
    connection,
    signedTransaction: transaction,
  });
}

async function distributeDiscord(
  auth: AuthKeys,
  source: string,
  claimants: Claimants,
  drop: DropInfo,
) {
  if (!auth.botToken) {
    throw new Error('Discord auth keys not supplied');
  }
  if (claimants.length === 0) return [];
  log.debug('Discord auth', auth);

  const client = new discord.Client();
  await client.login(auth.botToken);

  const members = {};
  for (const c of claimants) {
    members[c.handle] = await client.users.fetch(c.handle);
  }

  const single = async (info: ClaimantInfo, drop: DropInfo) => {
    const user = members[info.handle];
    if (user === undefined) {
      return {
        status: 'error',
        handle: info.handle,
        error: 'notfound',
      };
    }
    const formatted = formatDropMessage(info, drop, false);
    const response = await (user as any).send(formatted.message);
    // canonoical way to check if message succeeded?
    if (response.id) {
      return {
        status: 'success',
        handle: info.handle,
        messageId: response.id,
      };
    } else {
      return {
        status: 'error',
        handle: info.handle,
        error: response, // TODO
      };
    }
  };

  const responses = Array<DResponse>();
  for (const c of claimants) {
    responses.push(await single(c, drop));
  }
  client.destroy();
  return responses;
}

program.parse(process.argv);
