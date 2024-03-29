const { mnemonicGenerate, mnemonicValidate } = require('@polkadot/util-crypto');
const { initKeyring } = require('./config.js');
const { buildConnection } = require('./connection.js');

const IDENTIFIER_PREFIX = 'did:ssid:';
const IDENTIFIER_MAX_LENGTH = 20;
const IDENTIFIER_MIN_LENGTH = 3;

const generateMnemonic = () => mnemonicGenerate();

const checkIdentifierFormat = (identifier) => {
  const format = /^[0-9a-zA-Z]+$/;

  return format.test(identifier);
};
/**
 * Generate did object to be stored in blockchain.
 * @param {String} mnemonic
 * @param {String} identifier
 * @param {String} metadata
 * @returns {Object} Object containing did structure
 */
const generateDID = async (mnemonic, identifier, metadata = '') => {
  const keyring = await initKeyring();
  const isValidIdentifier = checkIdentifierFormat(identifier);
  const isValidMnemonic = mnemonicValidate(mnemonic);
  if (!isValidMnemonic) {
    throw new Error({
      errorCode: 'notValidMnemonic',
      errorMessage: 'Not valid mnemonic supplied',
    });
  }
  if (!isValidIdentifier) {
    throw new Error({
      errorCode: 'notValidIdentifier',
      errorMessage: 'Not valid identifier supplied',
    });
  }
  if (
    identifier.length > IDENTIFIER_MAX_LENGTH ||
    identifier.length < IDENTIFIER_MIN_LENGTH
  ) {
    throw new Error({
      errorCode: 'identifierLengthInvalid',
      errorMessage: 'Identifier length invalid',
    });
  }
  const pubKey = await keyring.addFromUri(mnemonic).publicKey;
  return {
    public_key: pubKey, // this is the public key linked to the did
    identity: IDENTIFIER_PREFIX + identifier, // this is the actual did
    metadata,
  };
};

/**
 * Store the generated DID object in blockchain
 * @param {Object} DID
 * @param {Object} signingKeypair
 * @param {ApiPromise} api
 * @returns {string} txnId Txnid for storage operation.
 */
function storeDIDOnChain(DID, signingKeypair, api = false) {
  return new Promise(async (resolve, reject) => {
    try {
      const provider = api || (await buildConnection('local'));

      const tx = provider.tx.did.add(DID.public_key, DID.identity, DID.metadata);

      await tx.signAndSend(signingKeypair, ({ status, dispatchError }) => {
        console.log('Transaction status:', status.type);
        if (dispatchError) {
          if (dispatchError.isModule) {
            // for module errors, we have the section indexed, lookup
            const decoded = api.registry.findMetaError(dispatchError.asModule);
            const { documentation, name, section } = decoded;
            console.log(`${section}.${name}: ${documentation.join(' ')}`);
            reject('Dispatch Module error');
          } else {
            // Other, CannotLookup, BadOrigin, no extra info
            console.log(dispatchError.toString());
            reject('Dispatch error');
          }
        } else if (status.isFinalized) {
          console.log('Finalized block hash', status.asFinalized.toHex());
          resolve(status.asFinalized.toHex());
        }
      });
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
}

/**
 * Get did information from accountID
 * @param {String} identifier DID Identifier
 * returns {JSON}
 */
async function getDIDDetails(identifier, api = false) {
  try {
    const provider = api || (await buildConnection('local'));
    const data = (await provider.query.did.dIDs(identifier)).toJSON();
    return {
      identifier: data[0].identifier,
      public_key: data[0].public_key,
      metadata: data[0].metadata,
      added_block: data[1],
    };
  } catch (error) {
    throw Error('Failed to fetch details');
  }
}

/**
 * Get the accountId for a given DID
 * @param {String} identifier
 * @param {ApiPromise} api
 * @returns {String}
 */
async function resolveDIDToAccount(identifier, api = false) {
  const provider = api || (await buildConnection('dev'));
  const data = (await provider.query.did.lookup(identifier)).toHuman();
  return data;
}

/**
 * Get the DID associated to given accountID
 * @param {String} accountId (hex/base64 version works)
 * @param {ApiPromise} api
 * @returns {String | Boolean} (false if not found)
 */
async function resolveAccountIdToDid(accountId, api = false) {
  const provider = api || (await buildConnection('dev'));
  const data = (await provider.query.did.rLookup(accountId)).toHuman();
  // return false if empty
  if (data === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    return false;
  }
  return data;
}

/**
 * This function will rotate the keys assiged to a DID
 * It should only be called by validator accounts, else will fail
 * @param {String} identifier
 * @param {Uint8Array} newKey
 * @param {KeyringObj} signingKeypair // of a validator account
 * @param {ApiPromise} api
 */
async function updateDidKey(identifier, newKey, signingKeypair, api) {
  const provider = api || (await buildConnection('local'));
  // call the rotateKey extrinsinc
  const tx = provider.tx.did.rotateKey(identifier, newKey);
  const signedtx = await tx.signAndSend(signingKeypair);
  return signedtx.toHex();
}

/**
 * Convert to hex but return fixed size always, mimics substrate storage
 * @param {String} data
 * @param {Int} size
 * @return {String}
 */
function convertFixedSizeHex(data, size = 64) {
  if (data.length > size) throw new Error('Invalid Data');
  const identifierHex = Buffer.from(data).toString('hex');
  return `0x${identifierHex.padEnd(size, '0')}`;
}

/**
 * Check if the user is an approved validator
 * @param {String} identifier
 * @param {ApiPromise} api
 * @returns {Bool}
 */
async function isDidValidator(identifier, api = false) {
  const provider = api || (await buildConnection('local'));
  // convert the identifier to hex notation
  const identifierHex = convertFixedSizeHex(identifier);
  const vList = (await provider.query.validatorSet.members()).toJSON();
  for (x of vList) {
    if (x.toString() === identifierHex) return true;
  }
  return false;
}

/**
 * Fetch the history of rotated keys for the specified DID
 * @param {String} identifier
 * @param {ApiPromise} api
 * returns Array
 */
async function getDidKeyHistory(identifier, api = false) {
  const provider = api || (await buildConnection('dev'));
  const data = (await provider.query.did.prevKeys(identifier)).toHuman();
  return data;
}

/**
 *
 * @param {String} identifier
 * @param {String} metadata
 * @param {KeyringObj} signingKeypair // of a validator account
 * @param {ApiPromise} api
 */
async function updateMetadata(identifier, metadata, signingKeypair, api = false) {
  const provider = api || (await buildConnection('dev'));
  const tx = provider.tx.did.updateMetadata(identifier, metadata);
  const signedtx = await tx.signAndSend(signingKeypair);
  return signedtx.toHex();
}

module.exports = {
  generateMnemonic,
  generateDID,
  storeDIDOnChain,
  getDIDDetails,
  updateDidKey,
  resolveDIDToAccount,
  getDidKeyHistory,
  resolveAccountIdToDid,
  isDidValidator,
  updateMetadata,
};
