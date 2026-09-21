import TelegramBot from 'node-telegram-bot-api'

const TELEGRAM_BOT_TOKEN = '8579150580:AAGElHtuf_qGy_fids8WCJTRzUMAz-H3_N8'

async function getChatId() {
    const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })

    try {
        console.log('Testing bot connection...')
        const botInfo = await bot.getMe()
        console.log('✅ Bot connected:', botInfo.username)

        console.log('\nFetching updates to get chat ID...')
        const updates = await bot.getUpdates()

        if (updates.length === 0) {
            console.log('\n⚠️  No updates found.')
            console.log('Please send a message to the bot in the group, then run this script again.')
            return
        }

        console.log(`\nFound ${updates.length} updates. Analyzing...`)

        // Look for group chats
        const groupChats = new Set()

        updates.forEach((update, index) => {
            const chat = update.message?.chat || update.my_chat_member?.chat
            if (chat) {
                console.log(`\nUpdate ${index + 1}:`)
                console.log(`  Chat ID: ${chat.id}`)
                console.log(`  Chat Type: ${chat.type}`)
                console.log(`  Chat Title: ${chat.title || 'N/A'}`)

                if (chat.type === 'group' || chat.type === 'supergroup') {
                    groupChats.add(chat.id)
                }
            }
        })

        if (groupChats.size > 0) {
            console.log('\n✅ Found group chat(s):')
            groupChats.forEach(id => {
                console.log(`  Chat ID: ${id}`)
            })

            console.log('\n📝 Add this to your .env file:')
            console.log(`TELEGRAM_GROUP_CHAT_ID=${Array.from(groupChats)[0]}`)
        } else {
            console.log('\n⚠️  No group chats found in updates.')
            console.log('Make sure the bot has been added to the group and someone has sent a message.')
        }

    } catch (error) {
        console.error('❌ Error:', error.message)
    }
}

getChatId()
