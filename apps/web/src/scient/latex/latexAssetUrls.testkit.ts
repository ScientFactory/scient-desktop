const refresh = async () => null;
const blocked = { _tag: "Failure", refresh } as const;
const readAsset = () => blocked;
const refreshAsset = () => refresh;

export { readAsset as useAssetUrlState, refreshAsset as useAssetUrlRefresh };
