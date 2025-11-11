import nacl from "tweetnacl";
import { PrismaClient } from "@prisma/client";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { workerMiddleware } from "../middleware";
import { TOTAL_DECIMALS, WORKER_JWT_SECRET } from "../config";
import { getNextTask } from "../db";
import { createSubmissionInput } from "../types";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { privateKey } from "../privateKey";
import { decode } from "bs58";
const connection = new Connection(process.env.RPC_URL ?? "");

const TOTAL_SUBMISSIONS = 100;

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

const router = Router();

router.post("/payout", workerMiddleware, async (req, res) => {
    // @ts-ignore
    const userId: string = req.userId;
    const worker = await prismaClient.worker.findFirst({
        where: { id: Number(userId) }
    })

    if (!worker) {
        return res.status(403).json({
            message: "User not found"
        })
    }

    const pending = Number(worker.pending_amount ?? 0);
    if (pending <= 0) {
        return res.status(400).json({ message: 'No pending amount to payout' });
    }

    // Reserve funds atomically: move pending_amount -> locked_amount and create a payout record
    let payoutRecord: any = null;
    try {
        const txResult = await prismaClient.$transaction(async tx => {
            // Decrement pending and increment locked in one transaction
            await tx.worker.update({
                where: { id: Number(userId) },
                data: {
                    pending_amount: { decrement: pending },
                    locked_amount: { increment: pending }
                }
            });

            const p = await tx.payouts.create({
                data: {
                    user_id: Number(userId),
                    amount: pending,
                    status: "Processing",
                    signature: ""
                }
            });

            return p;
        });

        payoutRecord = txResult;
    } catch (err) {
        console.error('Error reserving payout funds:', err);
        return res.status(500).json({ message: 'Failed to reserve funds for payout' });
    }

    // Build and send the on-chain transaction using the reserved amount
    const lamports = Math.floor(1_000_000_000 * pending / TOTAL_DECIMALS);
    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: new PublicKey("9isxjm1LY96pK8veLHYkHG72edjQ85A1qTbQjSFsfLC8"),
            toPubkey: new PublicKey(worker.address),
            lamports,
        })
    );

    const keypair = Keypair.fromSecretKey(decode(privateKey));

    let signature = "";
    try {
        signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
    } catch (e) {
        console.error('Blockchain transfer failed, reverting reserved funds:', e);
        // revert DB reservation and mark payout Failed
        try {
            await prismaClient.$transaction(async tx => {
                await tx.worker.update({
                    where: { id: Number(userId) },
                    data: {
                        pending_amount: { increment: pending },
                        locked_amount: { decrement: pending }
                    }
                });

                await tx.payouts.update({
                    where: { id: payoutRecord.id },
                    data: { status: 'Failure', signature: '' }
                });
            });
        } catch (err2) {
            console.error('Failed to revert reservation after failed transfer:', err2);
        }

        return res.status(500).json({ message: 'Transaction failed' });
    }

    // Update payout with signature and mark as Processing/Completed
    try {
        await prismaClient.payouts.update({
            where: { id: payoutRecord.id },
            data: { signature, status: 'Success' }
        });
    } catch (err) {
        console.error('Failed to update payout record after successful transfer:', err);
        // Do not revert funds here - manual reconciliation required
    }

    res.json({ message: 'Processing payout', amount: pending });


})

router.get("/balance", workerMiddleware, async (req, res) => {
    // @ts-ignore
    const userId: string = req.userId;

    const worker = await prismaClient.worker.findFirst({
        where: {
            id: Number(userId)
        }
    })

    res.json({
        pendingAmount: worker?.pending_amount,
        lockedAmount: worker?.pending_amount,
    })
})


router.post("/submission", workerMiddleware, async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    const body = req.body;
    const parsedBody = createSubmissionInput.safeParse(body);

    if (parsedBody.success) {
        const task = await getNextTask(Number(userId));
        if (!task || task?.id !== Number(parsedBody.data.taskId)) {
            return res.status(411).json({
                message: "Incorrect task id"
            })
        }

        const amount = (Number(task.amount) / TOTAL_SUBMISSIONS).toString();

        const submission = await prismaClient.$transaction(async tx => {
            const submission = await tx.submission.create({
                data: {
                    option_id: Number(parsedBody.data.selection),
                    worker_id: userId,
                    task_id: Number(parsedBody.data.taskId),
                    amount: Number(amount)
                }
            })

            await tx.worker.update({
                where: {
                    id: userId,
                },
                data: {
                    pending_amount: {
                        increment: Number(amount)
                    }
                }
            })

            return submission;
        })

        const nextTask = await getNextTask(Number(userId));
        res.json({
            nextTask,
            amount
        })
        

    } else {
        res.status(411).json({
            message: "Incorrect inputs"
        })
            
    }

})

router.get("/nextTask", workerMiddleware, async (req, res) => {
    // @ts-ignore
    const userId: string = req.userId;

    const task = await getNextTask(Number(userId));

    if (!task) {
        res.status(411).json({   
            message: "No more tasks left for you to review"
        })
    } else {
        res.json({   
            task
        })
    }
});

router.post("/signin", async(req, res) => {
    const { publicKey, signature } = req.body;
    const message = new TextEncoder().encode("Sign into mechanical turks as a worker");

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

    const existingUser = await prismaClient.worker.findFirst({
        where: {
            address: publicKey
        }
    })

    if (existingUser) {
        const token = jwt.sign({
            userId: existingUser.id
        }, WORKER_JWT_SECRET)

        res.json({
            token,
            amount: existingUser.pending_amount / TOTAL_DECIMALS
        })
    } else {
        const user = await prismaClient.worker.create({
            data: {
                address: publicKey,
                pending_amount: 0,
                locked_amount: 0
            }
        });

        const token = jwt.sign({
            userId: user.id
        }, WORKER_JWT_SECRET)

        res.json({
            token,
            amount: 0
        })
    }
});

export default router;