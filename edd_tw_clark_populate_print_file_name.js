/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Script Name:
 * Clark Core - Populate Print File Name
 *
 * Description:
 * For Clark Core Services Sales Orders, scans each line's Description
 * field for the first KSA-prefixed value and populates the Print File
 * Name field (custcol_printfilename).
 *
 * Matching is case-insensitive: KSA, ksa, and Ksa all match.
 * Lines that already have a Print File Name value are skipped.
 *
 * Executes on:
 *   - Create
 *   - Edit
 *
 * Does NOT execute on:
 *   - XEDIT (Inline Edit) — sublist access in XEDIT is limited to
 *     changed lines only, making full-order processing unreliable.
 */

define(['N/log'], (log) => {

    const CLARK_CUSTOMER_ID = 27425;
    const ITEM_SUBLIST      = 'item';
    const PRINT_FILE_FIELD  = 'custcol_printfilename';

    /*
     * Matches the first KSA-prefixed token.
     *
     * Flags:
     *   i — case-insensitive: KSA, ksa, Ksa all match
     *
     * \b  — word boundary: prevents mid-word matches (e.g. "NOKSA123")
     * \S+ — one or more non-whitespace characters after KSA
     *
     * Matches:   KSA123456  |  ksa-12345  |  Ksa_ABC99
     * No match:  NOKSA123   |  KSA (bare, no trailing characters)
     */
    const KSA_REGEX = /\b(KSA\S+)/i;

    function beforeSubmit(context) {

        const { CREATE, EDIT } = context.UserEventType;

        if (context.type !== CREATE &&
            context.type !== EDIT) {
            return;
        }

        try {

            const rec = context.newRecord;

            const customerId = Number(
                rec.getValue({
                    fieldId: 'entity'
                })
            );

            // Only process Clark Core Services orders
            if (customerId !== CLARK_CUSTOMER_ID) {
                return;
            }

            const lineCount = rec.getLineCount({
                sublistId: ITEM_SUBLIST
            });

            let updatedLines = 0;

            for (let i = 0; i < lineCount; i++) {

                // Preserve manually maintained values
                const currentValue = rec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId:   PRINT_FILE_FIELD,
                    line:      i
                });

                if (currentValue) {
                    continue;
                }

                const description = rec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId:   'description',
                    line:      i
                });

                if (!description) {
                    continue;
                }

                const match = description.match(KSA_REGEX);

                if (!match) {
                    continue;
                }

                rec.setSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId:   PRINT_FILE_FIELD,
                    line:      i,
                    value:     match[1]
                });

                updatedLines++;
            }

            if (updatedLines > 0) {

                log.audit({
                    title:   'Clark Core – Print File Names Updated',
                    details: `SO ${rec.id || '(new)'}: ${updatedLines} line(s) updated`
                });
            }

        } catch (e) {

            log.error({
                title:   'Clark Core – Print File Name Error',
                details: JSON.stringify({
                    name:    e.name,
                    message: e.message,
                    stack:   e.stack
                })
            });

            throw e;
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };

});
