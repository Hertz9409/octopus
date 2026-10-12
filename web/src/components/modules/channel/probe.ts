import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { useFetchModel } from '@/api/channel';
import { grantKey, toChannelConfig, toChannelDetail, type ChannelFormState } from './state';
import { buildSyncedDetail } from './sync';

// useModelProbe 按凭据探测上游模型列表, 供模型页与凭据页共用。
// 两侧并发探测与协议位判定都在后端完成, 此处只负责转圈状态, 并用探测结果整体替换模型与授权。
export function useModelProbe() {
    const t = useTranslations('channel.form');
    const fetchModel = useFetchModel();
    const [pendingKey, setPendingKey] = useState<string | null>(null); // 正在探测的凭据名称, 只转动该行的图标。

    // probe 探测指定凭据可用的模型, 结果只替换这一个凭据的模型与授权:
    // 该凭据下上游已下线的模型随之移除, 其授权与引用它的分组成员由后端级联删除; 上游返回空列表则该凭据的模型清空。
    // 其它凭据此时未被探测, 它们仍在引用的模型与授权原样保留, 不会被这一次探测连带删除。
    const probe = async (
        state: ChannelFormState,
        setState: (next: ChannelFormState) => void,
        keyName: string,
    ) => {
        // 模型页的刷新按钮不按凭据禁用, 选中的凭据可能还没填 Key, 在此挡掉空请求。
        const channelKey = state.keys.find((k) => k.name === keyName);
        if (!channelKey || channelKey.key.trim() === '') return;

        setPendingKey(keyName);
        try {
            // 探测用的地址, 路径, 代理和过滤表达式必须和保存后生效的完全一致, 否则这里探到的模型
            // 与实际转发时能用的模型会不一样; 故与提交共用同一份配置, 探测用不上的字段由后端忽略。
            const fetched = await fetchModel.mutateAsync({
                channel: toChannelConfig(state),
                key: channelKey.key.trim(),
            });
            const detail = toChannelDetail(state, 0);
            // 只替换被探测凭据的模型与授权: 其它凭据仍在引用的模型先放进保留列表, 交给 buildSyncedDetail 原样留下。
            const otherKeyModels = new Set(
                detail.grants.filter((grant) => grant.key_name !== channelKey.name).map((grant) => grant.model_name),
            );
            const keepModels = detail.models.filter((name) => otherKeyModels.has(name));
            const next = buildSyncedDetail(detail, [{ keyName: channelKey.name, models: fetched }], keepModels);
            setState({
                ...state,
                models: next.models,
                grants: new Map(next.grants.map((grant) => [grantKey(grant.model_name, grant.key_name), grant.protocols])),
            });
            if (next.models.length === 0) {
                toast.warning(t('modelRefreshCleared'));
            } else if (fetched.length === 0) {
                toast.warning(t('modelRefreshEmpty'));
            } else {
                toast.success(t('modelRefreshSuccess', { count: fetched.length }));
            }
        } catch (error) {
            toast.error(t('modelRefreshFailed'), { description: String(error) });
        } finally {
            setPendingKey(null);
        }
    };

    return { probe, pendingKey };
}
