/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Tossware - Stamp PFN Last Updated Date on Sales Order Line
 *
 * Author: Enislav Dimitrov
 * Updated: 07/13/2026
 *
 * Fires on Edit only. Compares old vs. new custcol_printfilename value
 * per line (matched via lineuniquekey, safe against line reordering),
 * and stamps today's date into custcol_pfn_last_updated whenever the
 * PFN value changes (added, edited, or cleared) on that specific line.
 */
define([], () => {
    const ITEM_SUBLIST = 'item';
    const LINE_KEY_FIELD = 'lineuniquekey';
    const PFN_FIELD = 'custcol_printfilename';
    const PFN_LAST_UPDATED_FIELD = 'custcol_pfn_last_updated';

    /**
     * Normalize values so null, undefined and '' compare equally.
     */
    const normalize = (value) => {
        return value == null ? '' : String(value);
    };

    const beforeSubmit = (context) => {
        const { type, UserEventType, newRecord, oldRecord } = context;

        if (type !== UserEventType.EDIT || !oldRecord) {
            return;
        }

        // Build lookup of old PFN values keyed by lineuniquekey
        const oldLineMap = new Map();
        const oldLineCount = oldRecord.getLineCount({
            sublistId: ITEM_SUBLIST
        });

        for (let i = 0; i < oldLineCount; i++) {
            const key = oldRecord.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: LINE_KEY_FIELD,
                line: i
            });

            if (!key) {
                continue;
            }

            oldLineMap.set(
                key,
                normalize(
                    oldRecord.getSublistValue({
                        sublistId: ITEM_SUBLIST,
                        fieldId: PFN_FIELD,
                        line: i
                    })
                )
            );
        }

        const today = new Date();
        const newLineCount = newRecord.getLineCount({
            sublistId: ITEM_SUBLIST
        });

        for (let i = 0; i < newLineCount; i++) {
            const key = newRecord.getSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: LINE_KEY_FIELD,
                line: i
            });

            if (!key) {
                continue;
            }

            const newPfn = normalize(
                newRecord.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: PFN_FIELD,
                    line: i
                })
            );

            const oldPfn = oldLineMap.get(key) ?? '';

            // Stamp only when the PFN actually changed on this line.
            // New lines with a PFN will also be stamped.
            if (newPfn !== oldPfn) {
                newRecord.setSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: PFN_LAST_UPDATED_FIELD,
                    line: i,
                    value: today
                });
            }
        }
    };

    return {
        beforeSubmit
    };
});