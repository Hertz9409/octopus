// isChunkLoadError 判断是否为前端资源加载失败，通常是版本更新后旧 chunk 已不存在。
export function isChunkLoadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);

    return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}
