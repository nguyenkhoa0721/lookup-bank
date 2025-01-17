import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Bank Account Service
class BankAccountService {
    private readonly API_URL =
        "https://online.mbbank.com.vn/api/retail_web/transfer/inquiryAccountName";
    private readonly KEEP_ALIVE_URL =
        "https://online.mbbank.com.vn/api/retail_web/internetbanking/getFavorBeneficiaryList";
    private readonly AUTH_TOKEN = "Basic RU1CUkVUQUlMV0VCOlNEMjM0ZGZnMzQlI0BGR0AzNHNmc2RmNDU4NDNm";
    private readonly SESSION_ID: string;
    private readonly REF_NO = "NGUYENKHOA0721-2025011711133277-81789";
    private keepAliveInterval: NodeJS.Timeout | null = null;

    constructor() {
        const sessionId = process.env.MB_BANK_SESSION_ID;
        if (!sessionId) {
            throw new Error("MB_BANK_SESSION_ID environment variable is not set");
        }
        this.SESSION_ID = sessionId;
        this.startKeepAlive();
    }

    private startKeepAlive() {
        console.log("Starting keep-alive service...");
        // Initial keep-alive call
        this.keepAliveCall();

        // Set up interval for subsequent calls
        this.keepAliveInterval = setInterval(() => {
            this.keepAliveCall();
        }, 60000); // Run every 1 minute
    }

    private async keepAliveCall() {
        try {
            const response = await fetch(this.KEEP_ALIVE_URL, {
                method: "POST",
                headers: {
                    Authorization: this.AUTH_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    transactionType: "PAYMENT",
                    searchType: "LATEST",
                    sessionId: this.SESSION_ID,
                    refNo: this.REF_NO,
                }),
            });

            if (!response.ok) {
                throw new Error(`Keep-alive HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            console.log("Keep-alive call successful:", new Date().toISOString());
        } catch (error) {
            console.error("Keep-alive call failed:", error);
        }
    }

    async lookupAccount(bankBin: string, accountNo: string) {
        try {
            const response = await fetch(this.API_URL, {
                method: "POST",
                headers: {
                    authorization: this.AUTH_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    creditAccount: accountNo,
                    creditAccountType: "ACCOUNT",
                    bankCode: bankBin,
                    debitAccount: accountNo,
                    type: "FAST",
                    sessionId: this.SESSION_ID,
                    refNo: this.REF_NO,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data.result.ok || data.result.responseCode !== "00") {
                throw new Error(`API error: ${data.result.message}`);
            }

            return {
                accountNo,
                accountName: data.benName,
                bankBin,
            };
        } catch (error) {
            console.error("Error looking up bank account:", error);
            throw error;
        }
    }

    cleanup() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            console.log("Keep-alive service stopped");
        }
    }
}

// Initialize service
const bankService = new BankAccountService();

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("SIGTERM signal received. Cleaning up...");
    bankService.cleanup();
    process.exit(0);
});

process.on("SIGINT", () => {
    console.log("SIGINT signal received. Cleaning up...");
    bankService.cleanup();
    process.exit(0);
});

// API Endpoint
app.post("/", async (req: Request, res: any) => {
    try {
        const { bankBin, accountNo } = req.body;

        // Basic validation
        if (!bankBin || !accountNo) {
            return res.status(400).json({
                status: "error",
                message: "bankBin and accountNo are required",
            });
        }

        const result = await bankService.lookupAccount(bankBin, accountNo);

        res.json({
            status: "success",
            data: result,
        });
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({
            status: "error",
            message: "Failed to lookup account",
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log("Keep-alive service is active");
});
