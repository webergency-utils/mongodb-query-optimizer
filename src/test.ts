import { optimizePipeline } from ".";

// Let's print the optimized pipeline first
const pipeline = [
    { $match: { type: { $in: ['fruit', 'vegetable'] } } },
    {
        $lookup: {
            from: 'suppliers',
            localField: 'supplierId',
            foreignField: '_id',
            as: 'supplierInfo'
        }
    },
    //{ $unwind: { path: '$supplierInfo', preserveNullAndEmptyArrays: false } },
    //{ $group: { _id: '$_id', name: { $first: '$name' }, type: { $first: '$type' }, price: { $first: '$price' }, stock: { $first: '$stock' }, supplierId: { $first: '$supplierId' }, supplierInfo: { $first: '$supplierInfo' } } },
    { $addFields: { totalValue: { $sum: [{ $add: ['$price', 0] }, 0] } } },
    //{ $match: { 'supplierInfo.country': 'USA' } },
    { $sort: { price: 1 } },
    { $project: { name: 1, price: 1, totalValue: 1, supplierCountry: '$supplierInfo.country' } },
    { $match: { price: { $gt: 1.0 } } },
    { $limit: 2 }
];

console.dir(optimizePipeline(pipeline), { depth: null });