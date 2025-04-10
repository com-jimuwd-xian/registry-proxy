/**
 * 解析字符串中的环境变量占位符（格式为 `${ENV_VAR}`），并替换为实际环境变量的值。
 * - 若环境变量不存在，则占位符会被替换为空字符串 `''`。
 * - 若输入为 `null` 或 `undefined`，直接返回原值（不处理）。
 *
 * @param str - 待处理的字符串，可能包含环境变量占位符（如 `${API_URL}`）。支持 `null` 或 `undefined`。
 * @returns 处理后的字符串。若输入为 `null` 或 `undefined`，返回原值；否则返回替换后的新字符串。
 *
 * @example
 * // 环境变量未定义时，替换为 ''
 * resolveEnvValue('${UNDEFINED_VAR}'); // => ''
 *
 * // 混合替换
 * resolveEnvValue('Host: ${HOST}, Port: ${PORT}'); // => 'Host: 127.0.0.1, Port: 3000'（假设环境变量已定义）
 *
 * // 保留 null/undefined
 * resolveEnvValue(null); // => null
 */
export default function resolveEnvValue(str: string | null | undefined): string | null | undefined {
    // 1. 处理 null 或 undefined 输入：直接返回原值
    if (str == null) {
        return str;
    }

    // 2. 使用正则表达式全局匹配所有 ${...} 占位符
    //    - 正则说明: \${(.+?)}
    //      - \${ 匹配字面量 `${`
    //      - (.+?) 非贪婪匹配任意字符（环境变量名），直到遇到第一个 `}`
    //      - /g 标志确保替换全部匹配项（而非仅第一个）
    //    - 替换逻辑: 若 process.env[key] 不存在（undefined/null），则返回 ''
    return str.replace(/\${(.+?)}/g, (_, key: string) => {
        return process.env[key] ?? '';
    });
}