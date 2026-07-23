/*
 * Copyright (c) 2026, Tossware. All rights reserved.
 *
 * Script brief description:
 *   User Event Script deployed on Sales Order (Edit only). Fires on every edit
 *   of a Shopify-imported SO (identified by custbody_celigo_etail_order_id
 *   being populated) that is in Pending Fulfillment status.
 *
 *   Two types of lines are handled:
 *
 *   1. PRINTED ASSEMBLY LINES (Assembly/BOM + item name contains "printed"):
 *      Committed to Complete Qty line-by-line only when a print file name is
 *      present on that line. Lines without a filename remain at Do Not Commit.
 *      The linked Work Order is updated to Complete Qty when the line commits.
 *
 *   2. ALL OTHER UNCOMMITTED LINES (non-printed or non-Assembly):
 *      Committed to Complete Qty on every edit regardless of filename, as long
 *      as the line is not already at Complete Qty or manually set to Available Qty.
 *      This ensures non-printed lines that may have been missed by the Customer
 *      Deposit script are always caught and committed.
 *
 * Revision History:
 *
 * Date         Issue/Case   Author            Issue Fix Summary
 * =============================================================================
 * 06/18/26                  Enislav           Initial version. Complements the
 *                           Dimitrov          Customer Deposit commit script. That
 *                                             script holds Shopify printed Assembly
 *                                             lines at Do Not Commit when no print
 *                                             file name exists at deposit time. This
 *                                             script handles the follow-up: when a
 *                                             print file name is later added to those
 *                                             lines on the SO, it commits each line
 *                                             individually to Complete Qty and updates
 *                                             the respective Work Order to match.
 *                                             Also commits any other uncommitted
 *                                             non-printed lines on every SO edit
 *                                             regardless of filename.
 */

/**
 * =============================================================================
 * DEPLOYMENT INSTRUCTIONS
 * =============================================================================
 * File Name   : edd_tw_tossware_so_printfile_commit.js
 * Script ID   : customscript_edd_tw_so_printfile_commit  (suggested)
 * Script Name : EDD TW – Tossware SO Print File Commit
 * Record Type : Sales Order
 * Event       : After Submit
 * Operations  : Edit only
 * Exec Context: All
 *
 * No script parameters required.
 * =============================================================================
 */

/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/format'],

    function (record, format) {

        // Line commit status internal IDs — verify against your account
        var COMMIT_AVAILABLEQTY = '1'; // Available Qty  — never touched by this script
        var COMMIT_COMPLETEQTY  = '2'; // Complete Qty

        // WO order status for Released
        var WO_STATUS_RELEASED = 'B';

        // =====================================================================
        // MAIN ENTRY POINT
        // =====================================================================
        function afterSubmit(scriptContext) {
            // Edit events only — creates are handled by the Customer Deposit script
            if (scriptContext.type !== 'edit') return;

            try {
                var newRec = scriptContext.newRecord;
                var oldRec = scriptContext.oldRecord;
                var soid   = newRec.id;

                // ---------------------------------------------------------------
                // Guard: Shopify/Celigo orders only
                // ---------------------------------------------------------------
                var celigoOrderId = newRec.getValue({fieldId: 'custbody_celigo_etail_order_id'});
                if (isEmpty(celigoOrderId)) {
                    log.debug('printfileCommit', 'SO ' + soid + ' – not a Shopify order, skipping.');
                    return;
                }

                // ---------------------------------------------------------------
                // Guard: Pending Fulfillment only
                // ---------------------------------------------------------------
                var orderStatus = newRec.getValue({fieldId: 'status'});
                if (orderStatus !== 'pendingFulfillment') {
                    log.debug('printfileCommit', 'SO ' + soid + ' – status is "' + orderStatus + '", skipping.');
                    return;
                }

                log.debug('printfileCommit', 'SO ' + soid + ' – Shopify order, processing lines.');

                var currdate   = format.parse({value: new Date(), type: format.Type.DATE});
                var itemcount  = newRec.getLineCount({sublistId: 'item'});
                var allwo      = []; // WO IDs queued for update
                var bSOUpdated = false;

                // ---------------------------------------------------------------
                // Load a dynamic copy of the SO for line edits
                // (afterSubmit newRecord is read-only)
                // ---------------------------------------------------------------
                var recso = record.load({type: 'salesorder', id: soid, isDynamic: true});

                for (var i = 0; i < itemcount; i++) {

                    var itmtype = newRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_sna_tw_itm_type', line: i});
                    var itmname = (newRec.getSublistText({sublistId: 'item', fieldId: 'item', line: i}) || '').toLowerCase();
                    var comminv = newRec.getSublistValue({sublistId: 'item', fieldId: 'commitinventory', line: i});
                    var wo      = newRec.getSublistValue({sublistId: 'item', fieldId: 'woid', line: i});
                    var dtecomm = newRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_sna_tw_date_committed', line: i});

                    var bIsAssembly     = (itmtype === 'Assembly/Bill of Materials');
                    var bIsPrintedItem  = (itmname.indexOf('printed') !== -1);

                    // Never touch lines already at Complete Qty or manually set to Available Qty
                    if (comminv === COMMIT_AVAILABLEQTY || comminv === COMMIT_COMPLETEQTY) {
                        log.debug('printfileCommit', 'Line ' + i + ' – already at status "' + comminv + '", skipping.');
                        continue;
                    }

                    var bShouldCommit = false;

                    // -----------------------------------------------------------
                    // PATH A — Printed Assembly lines
                    // Commit only if a print file name is NOW populated on the line.
                    // Each line is evaluated independently (line-by-line commitment).
                    // -----------------------------------------------------------
                    if (bIsAssembly && bIsPrintedItem) {
                        var newFilename = (newRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_printfilename', line: i}) || '').trim();
                        var oldFilename = (oldRec.getSublistValue({sublistId: 'item', fieldId: 'custcol_printfilename', line: i}) || '').trim();

                        if (!isEmpty(newFilename)) {
                            bShouldCommit = true;
                            log.audit('printfileCommit',
                                'Line ' + i + ' [PRINTED ASSEMBLY] – item "' + itmname
                                + '" filename: "' + newFilename + '" (was: "' + oldFilename + '"). Committing.');
                        } else {
                            log.debug('printfileCommit',
                                'Line ' + i + ' [PRINTED ASSEMBLY] – item "' + itmname + '" has no filename. Keeping Do Not Commit.');
                        }
                    }

                    // -----------------------------------------------------------
                    // PATH B — All other uncommitted lines (non-printed or non-Assembly)
                    // Commit regardless of filename on every edit.
                    // -----------------------------------------------------------
                    else {
                        bShouldCommit = true;
                        log.audit('printfileCommit',
                            'Line ' + i + ' [NON-PRINTED] – item "' + itmname + '" type "' + itmtype + '". Committing.');
                    }

                    // -----------------------------------------------------------
                    // Apply commitment
                    // -----------------------------------------------------------
                    if (bShouldCommit) {
                        recso.selectLine({sublistId: 'item', line: i});
                        recso.setCurrentSublistValue({sublistId: 'item', fieldId: 'commitinventory', value: COMMIT_COMPLETEQTY});

                        // Stamp commit date only if not already set
                        var existingDtecomm = recso.getCurrentSublistValue({sublistId: 'item', fieldId: 'custcol_sna_tw_date_committed'});
                        if (isEmpty(existingDtecomm)) {
                            recso.setCurrentSublistValue({sublistId: 'item', fieldId: 'custcol_sna_tw_date_committed', value: currdate});
                        }

                        recso.commitLine({sublistId: 'item'});
                        bSOUpdated = true;

                        // Queue the linked WO for update if one exists (deduplicated)
                        if (!isEmpty(wo) && !inArray_(wo, allwo)) {
                            allwo.push(wo);
                        }
                    }
                }

                // ---------------------------------------------------------------
                // Save the SO if any lines were updated
                // ---------------------------------------------------------------
                if (bSOUpdated) {
                    var savedId = recso.save({ignoreMandatoryFields: true, enableSourcing: true});
                    log.audit('printfileCommit', 'SO saved: ' + savedId);
                } else {
                    log.debug('printfileCommit', 'SO ' + soid + ' – no lines required updating.');
                    return; // nothing to do — skip WO loop
                }

                // ---------------------------------------------------------------
                // Update each queued Work Order to Complete Qty + Released
                // ---------------------------------------------------------------
                for (var j = 0; j < allwo.length; j++) {
                    updateWorkOrder(allwo[j], currdate);
                }

            } catch (e) {
                log.error('printfileCommit ERROR', (e.message ? e.name + ': ' + e.message : e.toString()));
            }
        }

        // =====================================================================
        // HELPER: Set WO lines to Complete Qty, stamp commit date, set Released
        // =====================================================================
        function updateWorkOrder(woid, dateCommitted) {
            try {
                log.debug('printfileCommit | updateWorkOrder', 'Updating WO: ' + woid);

                var recWO     = record.load({type: 'workorder', id: woid, isDynamic: false});
                recWO.setValue({fieldId: 'orderstatus', value: WO_STATUS_RELEASED});

                var itemcount = recWO.getLineCount({sublistId: 'item'});

                for (var i = 0; i < itemcount; i++) {
                    recWO.setSublistValue({sublistId: 'item', fieldId: 'commitinventory', line: i, value: COMMIT_COMPLETEQTY});

                    var dtecomm = recWO.getSublistValue({sublistId: 'item', fieldId: 'custcol_sna_tw_date_committed', line: i});
                    if (isEmpty(dtecomm)) {
                        recWO.setSublistValue({sublistId: 'item', fieldId: 'custcol_sna_tw_date_committed', line: i, value: dateCommitted});
                    }
                }

                var savedWo = recWO.save({ignoreMandatoryFields: true, enableSourcing: true});
                log.audit('printfileCommit | updateWorkOrder', 'WO updated: ' + savedWo);

            } catch (e) {
                log.error('printfileCommit | updateWorkOrder ERROR', (e.message ? e.name + ': ' + e.message : e.toString()));
            }
        }

        return {afterSubmit: afterSubmit};
    }
);

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================
function isEmpty(stValue) {
    return (
        (stValue === '' || stValue == null || stValue == undefined) ||
        (stValue.constructor === Array  && stValue.length == 0) ||
        (stValue.constructor === Object && (function (v) {
            for (var k in v) return false;
            return true;
        })(stValue))
    );
}

function inArray_(stValue, arrValue) {
    for (var i = arrValue.length - 1; i >= 0; i--) {
        if (stValue == arrValue[i]) return true;
    }
    return false;
}
