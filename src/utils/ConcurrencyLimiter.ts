export default class ConcurrencyLimiter {
    readonly maxConcurrency: number;
    private current: number = 0;
    private queue: Array<() => void> = [];

    constructor(maxConcurrency: number) {
        if (maxConcurrency <= 0) {
            throw new Error("maxConcurrency must be positive");
        }
        this.maxConcurrency = maxConcurrency;
    }

    async acquire(): Promise<void> {
        if (this.current < this.maxConcurrency) {
            this.current++;
            return;
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        if (this.current <= 0) {
            throw new Error("release() called without acquire()");
        }
        this.current--;
        const next = this.queue.shift();
        if (next) {
            // 异步执行，避免递归调用栈溢出
            Promise.resolve().then(() => {
                this.current++;
                next();
            });
        }
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }
}