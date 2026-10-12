// retryImport 在动态导入失败时重试一次，避免一次网络抖动就落到错误边界。
export async function retryImport<T>(load: () => Promise<T>, attempts = 2): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await load();
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
        }
    }

    throw lastError;
}
