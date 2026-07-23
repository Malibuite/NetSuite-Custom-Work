/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/log'], (log) => {
    const beforeSubmit = (context) => {
        try {
            if (
                context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT
            ) return;

            const { newRecord, oldRecord } = context;

            const oldLineMap = {};
            if (oldRecord) {
                const count = oldRecord.getLineCount({ sublistId: 'item' });
                for (let i = 0; i < count; i++) {
                    const key = oldRecord.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
                    if (key) oldLineMap[key] = oldRecord.getSublistValue({ sublistId: 'item', fieldId: 'isclosed', line: i });
                }
            }

            const closeDate = new Date();
            const count = newRecord.getLineCount({ sublistId: 'item' });

            for (let i = 0; i < count; i++) {
                if (!newRecord.getSublistValue({ sublistId: 'item', fieldId: 'isclosed', line: i })) continue;

                const key = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
                const existingCloseDate = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'custcol_line_closed_date', line: i });

                if (!oldLineMap[key] && !existingCloseDate) {
                    newRecord.setSublistValue({ sublistId: 'item', fieldId: 'custcol_line_closed_date', line: i, value: closeDate });
                }
            }
        } catch (e) {
            log.error({ title: 'beforeSubmit error', details: e.message });
            throw e;
        }
    };

    return { beforeSubmit };
});