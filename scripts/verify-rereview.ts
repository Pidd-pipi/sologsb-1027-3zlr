import {
  initialProcess,
  migrateProcess,
  historyReducer,
  stepFingerprint,
  invalidateConfirmedSteps,
  collectDownstream,
  demoteConfirmedSteps
} from '../src/App';

type AnyProcess = ReturnType<typeof initialProcess>;
type AnyHistory = { past: AnyProcess[]; present: AnyProcess; future: AnyProcess[] };

let failures = 0;
function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`, extra === undefined ? '' : JSON.stringify(extra, null, 2));
  }
}

// ---------- 1. 初始数据：确认记录完整且有效 ----------
console.log('1. 初始数据');
const initial = initialProcess();
check('初始含确认记录', initial.confirmations.length === 2, initial.confirmations);
check('初始确认记录均有效', initial.confirmations.every((record) => {
  const step = initial.steps.find((item) => item.id === record.stepId);
  return Boolean(step) && record.origin === 'recorded' && record.fingerprint === stepFingerprint(step!);
}));
check('初始无重新复核记录', initial.reReviews.length === 0);

// ---------- 2. 修改上游已确认步骤 → 下游已确认步骤回到待复核并记录 ----------
console.log('2. 修改上游步骤触发重新复核');
let history: AnyHistory = { past: [], present: initial, future: [] };
// 模拟 updateStep('materials', ...) 对 step-1 的提交
history = historyReducer(history, {
  type: 'commit',
  update: (draft) => {
    const step = draft.steps.find((item) => item.id === 'step-1');
    if (step) step.materials = '无水乙醇、去离子水、丙酮';
    invalidateConfirmedSteps(draft, 'step-1', ['材料']);
  }
});
const after = history.present;
const step1 = after.steps.find((item) => item.id === 'step-1')!;
const step2 = after.steps.find((item) => item.id === 'step-2')!;
check('触发步骤自身回到待复核', step1.status === 'submitted', step1.status);
check('下游已确认步骤回到待复核', step2.status === 'submitted', step2.status);
check('未确认步骤状态不变', after.steps.find((item) => item.id === 'step-3')!.status === 'submitted'
  && after.steps.find((item) => item.id === 'step-5')!.status === 'draft');
check('失效确认记录被移除', after.confirmations.length === 0, after.confirmations);
check('生成一条重新复核记录', after.reReviews.length === 1, after.reReviews);
const record = after.reReviews[0];
check('记录触发步骤', record.triggerStepId === 'step-1' && record.triggerStepTitle === step1.title, record);
check('记录变化字段', record.changedFields.join(',') === '材料', record.changedFields);
check('记录波及范围含自身与下游', record.affectedStepIds.includes('step-1') && record.affectedStepIds.includes('step-2'), record.affectedStepIds);
check('波及范围不含未确认步骤', !record.affectedStepIds.includes('step-3'), record.affectedStepIds);

// ---------- 3. 再次修改已无已确认步骤 → 不重复记录 ----------
console.log('3. 无已确认步骤时不产生记录');
history = historyReducer(history, {
  type: 'commit',
  update: (draft) => {
    const step = draft.steps.find((item) => item.id === 'step-1');
    if (step) step.materials = '无水乙醇';
    invalidateConfirmedSteps(draft, 'step-1', ['材料']);
  }
});
check('不新增重新复核记录', history.present.reReviews.length === 1, history.present.reReviews.length);

// ---------- 4. 撤销/重做连记录一起恢复 ----------
console.log('4. 撤销与重做');
const beforeUndo = history.present;
history = historyReducer(history, { type: 'undo' });
check('撤销后记录数回退', history.present.reReviews.length === 1);
history = historyReducer(history, { type: 'undo' });
check('撤销到修改前：步骤恢复已确认', history.present.steps.find((item) => item.id === 'step-1')!.status === 'confirmed');
check('撤销到修改前：确认记录恢复', history.present.confirmations.length === 2);
check('撤销到修改前：重新复核记录移除', history.present.reReviews.length === 0);
history = historyReducer(history, { type: 'redo' });
history = historyReducer(history, { type: 'redo' });
check('重做后步骤再次回到待复核', history.present.steps.find((item) => item.id === 'step-1')!.status === 'submitted');
check('重做后确认记录再次移除', history.present.confirmations.length === 0);
check('重做后重新复核记录恢复', history.present.reReviews.length === 1);
check('重做后材料为第二次修改值', history.present.steps.find((item) => item.id === 'step-1')!.materials === beforeUndo.steps[0].materials);

// ---------- 5. 依赖变化同样触发 ----------
console.log('5. 依赖变化触发');
let h2: AnyHistory = { past: [], present: initialProcess(), future: [] };
h2 = historyReducer(h2, {
  type: 'commit',
  update: (draft) => {
    const step = draft.steps.find((item) => item.id === 'step-3');
    if (step) step.dependencies = ['step-1', 'step-2'];
    invalidateConfirmedSteps(draft, 'step-3', ['依赖关系']);
  }
});
check('被修改步骤未确认时不影响他人', h2.present.steps.find((item) => item.id === 'step-2')!.status === 'confirmed'
  && h2.present.reReviews.length === 0);
// 直接改已确认步骤的依赖
h2 = historyReducer(h2, {
  type: 'commit',
  update: (draft) => {
    const step = draft.steps.find((item) => item.id === 'step-2');
    if (step) step.dependencies = [];
    invalidateConfirmedSteps(draft, 'step-2', ['依赖关系']);
  }
});
check('已确认步骤依赖变化后回到待复核', h2.present.steps.find((item) => item.id === 'step-2')!.status === 'submitted');
check('依赖变化记录字段为依赖关系', h2.present.reReviews.at(-1)!.changedFields.join(',') === '依赖关系');
// 注意：step-2 的下游 step-3 不是已确认，故波及范围只有 step-2
check('波及范围仅含已确认步骤', h2.present.reReviews.at(-1)!.affectedStepIds.join(',') === 'step-2', h2.present.reReviews.at(-1));

// ---------- 6. 删除步骤触发下游重新复核 ----------
console.log('6. 删除步骤触发');
let h3: AnyHistory = { past: [], present: initialProcess(), future: [] };
h3 = historyReducer(h3, {
  type: 'commit',
  update: (draft) => {
    const triggerTitle = draft.steps.find((item) => item.id === 'step-1')?.title ?? '未知步骤';
    const downstream = collectDownstream(draft.steps, 'step-1');
    draft.steps = draft.steps.filter((item) => item.id !== 'step-1');
    draft.steps.forEach((item) => { item.dependencies = item.dependencies.filter((dep) => dep !== 'step-1'); });
    demoteConfirmedSteps(draft, 'step-1', `${triggerTitle}（已删除）`, ['依赖关系'], downstream);
    draft.confirmations = draft.confirmations.filter((item) => item.stepId !== 'step-1');
  }
});
check('删除后下游已确认步骤回到待复核', h3.present.steps.find((item) => item.id === 'step-2')!.status === 'submitted');
check('删除记录标注已删除触发步骤', h3.present.reReviews.at(-1)!.triggerStepTitle.includes('已删除'));
check('被删步骤确认记录清理', h3.present.confirmations.every((item) => item.stepId !== 'step-1'));

// ---------- 7. 旧数据迁移：已有确认按来源不明处理 ----------
console.log('7. 旧数据迁移');
const legacy = JSON.parse(JSON.stringify(initialProcess())) as AnyProcess & { confirmations?: unknown; reReviews?: unknown };
delete legacy.confirmations;
delete legacy.reReviews;
const migrated = migrateProcess(legacy as AnyProcess);
check('旧数据补齐重新复核记录数组', Array.isArray(migrated.reReviews) && migrated.reReviews.length === 0);
check('已有确认生成来源不明记录', migrated.confirmations.length === 2
  && migrated.confirmations.every((item) => item.origin === 'unknown'), migrated.confirmations);
check('来源不明记录无法核验', migrated.confirmations.every((item) => {
  const step = migrated.steps.find((s) => s.id === item.stepId);
  return !step || item.fingerprint !== stepFingerprint(step);
}));
const modern = migrateProcess(initialProcess());
check('新数据迁移保持原记录', modern.confirmations.length === 2
  && modern.confirmations.every((item) => item.origin === 'recorded'));

// ---------- 8. 确认指纹：内容变化后可识别失效 ----------
console.log('8. 确认指纹核验');
const proc = initialProcess();
const rec = proc.confirmations.find((item) => item.stepId === 'step-1')!;
check('内容未变时确认有效', rec.fingerprint === stepFingerprint(proc.steps.find((item) => item.id === 'step-1')!));
proc.steps.find((item) => item.id === 'step-1')!.amount = '乙醇 200 mL';
check('内容变化后指纹不一致', rec.fingerprint !== stepFingerprint(proc.steps.find((item) => item.id === 'step-1')!));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
