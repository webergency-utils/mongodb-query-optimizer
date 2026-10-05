import { optimizePipeline } from ".";

// Let's print the optimized pipeline first
const pipeline = [
    {
        $sort: { "events.created": -1 }
    },
    {
        $match: { action: { $exists: true }, conversationID: { $in: [1, 2, 3] } }
    },
    {
        $group:
        {
            _id: "$conversationID",
            lastMessageAction: { $first: "$action" },
            lastMessageId: { $first: "$_id" },
            lastMessageDate: { $first: "$events.created" }
        }
    },
    {
        $match: { lastMessageAction: "awaiting_response" }
    }
];

console.dir(optimizePipeline(pipeline), { depth: null });