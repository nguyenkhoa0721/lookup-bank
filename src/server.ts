import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { createHash } from "crypto";
import Jimp from "jimp";
import { recognize } from "node-tesseract-ocr";
// @ts-ignore
import replaceColor from "replace-color";
import { Client } from "undici";
import { defaultHeaders, generateDeviceId, getTimeNow } from "./util";
import { wasmEnc } from "./loadWasm";

dotenv.config();

const app = express();
app.use(express.json());

// Bank Account Service
class BankAccountService {
    private readonly API_URL =
        "https://online.mbbank.com.vn/api/retail_web/transfer/inquiryAccountName";
    private readonly AUTH_TOKEN = "Basic RU1CUkVUQUlMV0VCOlNEMjM0ZGZnMzQlI0BGR0AzNHNmc2RmNDU4NDNm";
    private sessionId: string | null = null;
    private readonly username: string;
    private readonly password: string;
    private readonly deviceId: string;
    private client: Client;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private wasmData!: Buffer;

    constructor() {
        const username = process.env.MB_BANK_USERNAME;
        const password = process.env.MB_BANK_PASSWORD;

        if (!username || !password) {
            throw new Error(
                "MB_BANK_USERNAME and MB_BANK_PASSWORD environment variables are required"
            );
        }

        this.username = username;
        this.password = password;
        this.deviceId = generateDeviceId();
        this.client = new Client("https://online.mbbank.com.vn");

        this.initialize();
    }

    private async initialize() {
        try {
            await this.login();
        } catch (error) {
            console.error("Failed to initialize service:", error);
            throw error;
        }
    }

    private async login(): Promise<boolean> {
        try {
            console.log("Logging in...");
            const rId = getTimeNow();
            const headers = defaultHeaders as any;
            headers["X-Request-Id"] = rId;

            console.log("Getting Captcha");

            // Get captcha
            const captchaRes = await this.client.request({
                method: "POST",
                path: "/api/retail-web-internetbankingms/getCaptchaImage",
                headers,
                body: JSON.stringify({
                    sessionId: "",
                    refNo: rId,
                    deviceIdCommon: this.deviceId,
                }),
            });

            console.log("Got Captcha");

            const captchaData = (await captchaRes.body.json()) as any;

            console.log("Got Captcha Data", captchaData);
            let captchaBuffer = Buffer.from(captchaData.imageString, "base64");

            console.log("Processing Captcha");

            // Process captcha image
            const captchaImage1 = await replaceColor({
                image: captchaBuffer,
                colors: {
                    type: "hex",
                    targetColor: "#847069",
                    replaceColor: "#ffffff",
                },
            });
            captchaBuffer = await captchaImage1.getBufferAsync("image/png");

            const captchaImage2 = await replaceColor({
                image: captchaBuffer,
                colors: {
                    type: "hex",
                    targetColor: "#ffe3d5",
                    replaceColor: "#ffffff",
                },
            });
            captchaBuffer = await captchaImage2.getBufferAsync("image/png");

            const captchaContent = (
                await recognize(captchaBuffer, {
                    lang: "eng",
                    oem: 1,
                    psm: 7,
                })
            )
                .replaceAll("\n", "")
                .replaceAll(" ", "")
                .trim();

            console.log("Got Captcha Content", captchaContent);

            // Validate captcha
            if (captchaContent.length !== 6 || !/^[a-z0-9]+$/i.test(captchaContent)) {
                return this.login();
            }

            // Login request
            const loginData = {
                userId: this.username,
                password: createHash("md5").update(this.password).digest("hex"),
                captcha: captchaContent,
                deviceIdCommon: this.deviceId,
                sessionId: null,
                refNo: Date.now().toString(),
            };

            if (!this.wasmData) {
                const wasm = await this.client.request({
                    method: "GET",
                    path: "/assets/wasm/main.wasm",
                    headers: defaultHeaders,
                });
                this.wasmData = Buffer.from(await wasm.body.arrayBuffer());
            }

            const loginRes = await this.client.request({
                method: "POST",
                path: "/api/retail_web/internetbanking/v2.0/doLogin",
                headers,
                body: JSON.stringify({
                    dataEnc: await wasmEnc(this.wasmData, loginData, "0"),
                }),
            });

            const loginResult = (await loginRes.body.json()) as any;

            if (loginResult.result?.ok) {
                this.sessionId = loginResult.sessionId;
                console.log("Login successful");
                return true;
            } else if (loginResult.result?.responseCode === "GW283") {
                return this.login(); // Retry on specific error
            } else {
                throw new Error(
                    `Login failed: (${loginResult.result?.responseCode}): ${loginResult.result?.message}`
                );
            }
        } catch (error) {
            console.error("Login failed:", error);
            throw error;
        }
    }

    async lookupAccount(bankBin: string, accountNo: string): Promise<any> {
        try {
            // Ensure we have a valid session
            if (!this.sessionId) {
                await this.login();
            }

            const response = await this.client.request({
                method: "POST",
                path: "/api/retail_web/transfer/inquiryAccountName",
                headers: {
                    Authorization: this.AUTH_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    creditAccount: accountNo,
                    creditAccountType: "ACCOUNT",
                    bankCode: bankBin,
                    debitAccount: "0935823570",
                    type: bankBin == "970422" ? "INHOUSE" : "FAST",
                    sessionId: this.sessionId,
                    refNo: Date.now().toString(),
                    deviceIdCommon: this.deviceId,
                }),
            });

            const data = (await response.body.json()) as any;

            if (!data.result.ok) {
                if (data.result.responseCode === "GW200") {
                    // Session expired, try to login again
                    await this.login();
                    return this.lookupAccount(bankBin, accountNo);
                }
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
