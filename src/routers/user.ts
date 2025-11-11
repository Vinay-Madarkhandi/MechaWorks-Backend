import nacl from "tweetnacl";
import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import jwt from "jsonwebtoken";
import { JWT_SECRET, TOTAL_DECIMALS } from "../config";
import { authMiddleware } from "../middleware";
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { createTaskInput } from "../types";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

const connection = new Connection(process.env.RPC_URL ?? "");

const PARENT_WALLET_ADDRESS = "9isxjm1LY96pK8veLHYkHG72edjQ85A1qTbQjSFsfLC8";
    
const DEFAULT_TITLE = "Select the most clickable thumbnail";
// Initialize S3 client if AWS credentials are present. Make S3 optional
let s3Client: S3Client | undefined = undefined;
let s3Configured = false;
if (process.env.ACCESS_KEY_ID && process.env.ACCESS_SECRET) {
    s3Client = new S3Client({
        credentials: {
            accessKeyId: process.env.ACCESS_KEY_ID,
            secretAccessKey: process.env.ACCESS_SECRET,
        },
        region: process.env.AWS_REGION || "eu-north-1"
    });

    s3Configured = true;
    // best-effort validation (do not throw on startup to avoid crashing dev env)
    (async () => {
        try {
            await (s3Client as any).config.credentials();
            console.log('S3 client initialized successfully');
        } catch (error) {
            console.error('Failed to initialize S3 client:', error);
            s3Configured = false;
            s3Client = undefined;
        }
    })();
} else {
    console.warn('AWS credentials are not provided. S3-backed endpoints will be disabled.');
}

const router = Router();

const prismaClient = new PrismaClient();


prismaClient.$transaction(
    async (prisma) => {
      // Code running in a transaction...
    },
    {
      maxWait: 5000, // default: 2000
      timeout: 10000, // default: 5000
    }
)
router.get("/task", authMiddleware, async (req, res) => {
    try {
        // Input validation
        const taskId = Number(req.query.taskId);
        // @ts-ignore
        const userId = Number(req.userId);

        if (isNaN(taskId) || isNaN(userId)) {
            return res.status(400).json({
                message: "Invalid taskId or userId format"
            });
        }

        // Get task details and responses in parallel for better performance
        const [taskDetails, responses] = await Promise.all([
            prismaClient.task.findFirst({
                where: {
                    user_id: userId,
                    id: taskId
                },
                include: {
                    options: true
                }
            }),
            prismaClient.submission.findMany({
                where: {
                    task_id: taskId
                },
                include: {
                    option: true
                }
            })
        ]);

        if (!taskDetails) {
            return res.status(404).json({
                message: "Task not found or you don't have access to this task"
            });
        }

        // Initialize result object with counts
        const result = taskDetails.options.reduce((acc, option) => {
            acc[option.id] = {
                count: 0,
                option: {
                    imageUrl: option.image_url
                }
            };
            return acc;
        }, {} as Record<string, {count: number; option: {imageUrl: string}}>);

        // Count responses in a single pass
        responses.forEach(response => {
            if (result[response.option_id]) {
                result[response.option_id].count++;
            }
        });

        return res.json({
            result,
            taskDetails
        });

    } catch (error) {
        console.error('Error fetching task details:', error);
        return res.status(500).json({
            message: "Internal server error"
        });
    }
});


router.post("/task", authMiddleware, async (req, res) => {
    //@ts-ignore
    const userId = req.userId
    // validate the inputs from the user;
    const body = req.body;

    const parseData = createTaskInput.safeParse(body);

    const user = await prismaClient.user.findFirst({
        where: {
            id: userId
        }
    })

    if (!parseData.success) {
        return res.status(411).json({
            message: "You've sent the wrong inputs"
        })
    }

    const transaction = await connection.getTransaction(parseData.data.signature, {
        maxSupportedTransactionVersion: 1
    });

    console.log(transaction);
    if (!transaction) {
        console.error("Transaction not found for signature:", parseData.data.signature);
        return res.status(411).json({
            message: "Invalid transaction signature - transaction not found"
        });
    }

    // Add logging to debug transaction data
    console.log("Transaction meta:", {
        preBalances: transaction.meta?.preBalances,
        postBalances: transaction.meta?.postBalances
    });

    // Safely check the balance difference
    const preBalance = transaction.meta?.preBalances[1] ?? 0;
    const postBalance = transaction.meta?.postBalances[1] ?? 0;
    const balanceDifference = postBalance - preBalance;

    if (balanceDifference !== 100000000) {
        console.error("Invalid balance difference:", {
            expected: 100000000,
            actual: balanceDifference,
            preBalance,
            postBalance
        });
        return res.status(411).json({
            message: "Transaction amount incorrect"
        });
    }

    if (transaction?.transaction.message.getAccountKeys().get(1)?.toString() !== PARENT_WALLET_ADDRESS) {
        return res.status(411).json({
            message: "Transaction sent to wrong address"
        })
    }

    if (transaction?.transaction.message.getAccountKeys().get(0)?.toString() !== user?.address) {
        return res.status(411).json({
            message: "Transaction sent to wrong address"
        })
    }
    // was this money paid by this user address or a different address?

    // parse the signature here to ensure the person has paid 0.1 SOL
    // const transaction = Transaction.from(parseData.data.signature);

    let response = await prismaClient.$transaction(async tx => {

        const response = await tx.task.create({
            data: {
                title: parseData.data.title ?? DEFAULT_TITLE,
                amount: 0.1 * TOTAL_DECIMALS,
                //TODO: Signature should be unique in the table else people can reuse a signature
                signature: parseData.data.signature,
                user_id: userId
            }
        });

        await tx.option.createMany({
            data: parseData.data.options.map(x => ({
                image_url: x.imageUrl,
                task_id: response.id
            }))
        })

        return response;

    })

    res.json({
        id: response.id
    })

});

router.get("/presignedUrl", authMiddleware, async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    if (!s3Configured || !s3Client) {
        return res.status(501).json({ message: 'S3 not configured on server' });
    }

    try {
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: 'final-yearrr',
            Key: `${userId}/${Math.random()}/image.jpg`,
            Conditions: [
              ['content-length-range', 0, 5 * 1024 * 1024] // 5 MB max
            ],
            Expires: 3600
        })

        res.json({ preSignedUrl: url, fields });
    } catch (err) {
        console.error('Error creating presigned post:', err);
        res.status(500).json({ message: 'Failed to create presigned url' });
    }
    
})

router.post("/signin", async(req, res) => {
    const { publicKey, signature } = req.body;
    const message = new TextEncoder().encode("Sign into MechaWorks");

    const result = nacl.sign.detached.verify(
        message,
        new Uint8Array(signature.data),
        new PublicKey(publicKey).toBytes(),
    );


    if (!result) {
        return res.status(411).json({
            message: "Incorrect signature"
        })
    }

    const existingUser = await prismaClient.user.findFirst({
        where: {
            address: publicKey
        }
    })

    if (existingUser) {
        const token = jwt.sign({
            userId: existingUser.id
        }, JWT_SECRET)

        res.json({
            token
        })
    } else {
        const user = await prismaClient.user.create({
            data: {
                address: publicKey,
            }
        })

        const token = jwt.sign({
            userId: user.id
        }, JWT_SECRET)

        res.json({
            token
        })
    }
});

export default router;
