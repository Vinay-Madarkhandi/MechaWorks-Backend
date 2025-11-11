import { NextFunction, Request, Response } from "express";
import { JWT_SECRET, WORKER_JWT_SECRET } from "./config";
import jwt from "jsonwebtoken";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    // Accept either 'Bearer <token>' or raw token in the Authorization header
    const rawAuth = (req.headers.authorization ?? req.headers["Authorization"] ?? "") as string;
    const token = rawAuth.startsWith("Bearer ") ? rawAuth.split(" ")[1] : rawAuth;

    if (!token) {
        return res.status(401).json({ message: "Missing authorization token" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        if (decoded && decoded.userId) {
            // attach userId to request in a TS-friendly way
            (req as any).userId = decoded.userId;
            return next();
        } else {
            return res.status(403).json({ message: "You are not logged in" });
        }
    } catch (e) {
        console.error('authMiddleware error:', e);
        return res.status(403).json({ message: "You are not logged in" });
    }
}

export function workerMiddleware(req: Request, res: Response, next: NextFunction) { 
    const rawAuth = (req.headers.authorization ?? req.headers["Authorization"] ?? "") as string;
    const token = rawAuth.startsWith("Bearer ") ? rawAuth.split(" ")[1] : rawAuth;

    if (!token) {
        return res.status(401).json({ message: "Missing authorization token" });
    }

    try {
        const decoded = jwt.verify(token, WORKER_JWT_SECRET) as any;
        if (decoded && decoded.userId) {
            (req as any).userId = decoded.userId;
            return next();
        } else {
            return res.status(403).json({ message: "You are not logged in" });
        }
    } catch (e) {
        console.error('workerMiddleware error:', e);
        return res.status(403).json({ message: "You are not logged in" });
    }
}
