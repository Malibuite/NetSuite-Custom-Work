/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Deployment: Sales Order record type, After Submit, Create context (EDI import).
 * Script ID: customscript_edd_ue_27425_sh (existing deployment - replace the file
 * attached to this script record with this corrected version).
 *
 * =========================================================================
 * FIX IN THIS VERSION (2026-07-23)
 * =========================================================================
 * The previous version wrote to custpage_packship_billing / custpage_packship_zip /
 * custpage_packship_country / custpage_packship_billing_type. Those field IDs
 * do not exist on this account's Sales Order form, so every write silently
 * went nowhere even though the audit log reported "success."
 *
 * Verified actual field IDs (via NetSuite CustomField registry):
 *   custbody_packship_account_number  - Free-Form Text  - "Other Party Billing Account Number"
 *   custbody_packship_zip_code        - Free-Form Text  - "Other Party Zip Code"
 *   custbody_packship_country         - List/Record     - "Other Party Country"
 *                                        -> References the standard Country list, BUT
 *                                           (confirmed by writing this field manually
 *                                           and reading the raw stored value back via
 *                                           SuiteQL on 2026-07-23) it stores the
 *                                           Country record's internal NUMERIC id, not
 *                                           the 2-letter code used by native address
 *                                           fields. United States = 230. Submitting
 *                                           "US" throws INVALID_KEY_OR_REF.
 *   custbody_packship_billing_type    - List/Record     - "Other Party Billing type"
 *                                        -> customrecord_packship_3rd_party_types
 *                                           id 1 = "Third Party"
 *                                           id 2 = "Recipient"
 * =========================================================================
 * SECOND FIX (2026-07-23, same day):
 *   The first fix wrote the customer's thirdpartycountry.id ("US") straight into
 *   custbody_packship_country. That's an invalid key for this field and threw
 *   INVALID_KEY_OR_REF - and because record.submitFields() is all-or-nothing,
 *   that single bad value caused the ENTIRE call to fail, wiping out the
 *   shipmethod/account number/zip/billing type updates too, even though those
 *   values were correct. This version:
 *     1. Maps the alpha country code to the correct internal numeric id via
 *        COUNTRY_ID_MAP before writing (only 'US' is populated for now - this
 *        script only serves one customer, and 230 is confirmed correct for US).
 *     2. Splits the submitFields() call into two: shipmethod is always safe to
 *        submit on its own, and the four packship fields are submitted
 *        together but separately, wrapped in their own try/catch, so a future
 *        problem with any one of these fields can no longer silently block
 *        an otherwise-good update to the others.
 * =========================================================================
 *
 * Logic:
 * 1. Restricted to Customer Internal ID 27425 only.
 * 2. On record create, review "memo" and set "shipmethod":
 *      - contains "FEDX GRD"          -> 1038 (FedEx Ground)
 *      - contains "2nd Day Air"       -> 1044 (FedEx 2Day)
 *      - contains "Std Overnight"     -> 1043 (FedEx Standard Overnight)
 *      - contains "FEDX HME"          -> 2347 (FedEx Home Delivery)
 *      - contains "www.ClarkLTL.com"  -> 1944 (Wholesale FTL/LTL)
 *      - anything else                -> 1038 (FedEx Ground, default)
 * 3. Packship / other-party-billing fields:
 *      - If memo contains "www.ClarkLTL.com" AND the fields are already
 *        populated, clear all four fields.
 *      - If memo does NOT contain "www.ClarkLTL.com":
 *          - If the fields are already populated, no change needed.
 *          - If not populated, AND thirdpartyacct has a value on the
 *            CUSTOMER record (internal ID 27425 - these fields live on the
 *            customer record's Financial subtab, not on the sales order),
 *            copy:
 *              customer.thirdpartyacct    -> custbody_packship_account_number
 *              customer.thirdpartyzipcode -> custbody_packship_zip_code
 *              customer.thirdpartycountry -> custbody_packship_country
 *            and set custbody_packship_billing_type = 1 ("Third Party").
 *            If thirdpartyacct is blank on the customer record, no update
 *            is made (logged for visibility).
 *
 * IMPORTANT / DESIGN NOTES:
 *   - This script never performs a full record.load(dynamic) + record.save()
 *     on the sales order. All writes go through record.submitFields(), a
 *     targeted write that does not re-trigger inventory commitment
 *     recalculation or re-run approval routing the way a full save does.
 *   - record.submitFields() re-triggers User Event scripts on this record.
 *     This script is idempotent (it re-checks current values before
 *     writing), so the recursive re-entry finds nothing left to do and
 *     exits immediately. Don't remove that check or you risk an infinite
 *     loop.
 *   - Confirm 'thirdpartyacct' / 'thirdpartyzipcode' / 'thirdpartycountry'
 *     are still the correct field IDs on the CUSTOMER record in your
 *     account (verified present as of this writing).
 */
define(['N/record', 'N/log'], function (record, log) {

    var TARGET_CUSTOMER_ID = '27425';

    var SHIP_METHOD_MAP = {
        FEDX_GRD: '1038',
        SECOND_DAY_AIR: '1044',
        STD_OVERNIGHT: '1043',
        FEDX_HME: '2347',
        CLARK_LTL: '1944'
    };
    var DEFAULT_SHIP_METHOD = SHIP_METHOD_MAP.FEDX_GRD;

    var CLARK_LTL_TOKEN = 'WWW.CLARKLTL.COM';
    var THIRD_PARTY_BILLING_TYPE_ID = '1'; // customrecord_packship_3rd_party_types: 1 = "Third Party"

    // custbody_packship_country stores the Country record's internal numeric id,
    // NOT the 2-letter code used by native address fields (confirmed via manual
    // entry + SuiteQL readback on 2026-07-23). Extend this map if this customer's
    // third-party billing country is ever anything other than the US.
    var COUNTRY_ID_MAP = {
        US: '230'
    };

    // Checked in order; first match wins. ClarkLTL first on purpose.
    var SHIPPING_RULES = [
        { pattern: CLARK_LTL_TOKEN, shipMethod: SHIP_METHOD_MAP.CLARK_LTL },
        { pattern: 'STD OVERNIGHT', shipMethod: SHIP_METHOD_MAP.STD_OVERNIGHT },
        { pattern: '2ND DAY AIR', shipMethod: SHIP_METHOD_MAP.SECOND_DAY_AIR },
        { pattern: 'FEDX HME', shipMethod: SHIP_METHOD_MAP.FEDX_HME },
        { pattern: 'FEDX GRD', shipMethod: SHIP_METHOD_MAP.FEDX_GRD }
    ];

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE) {
                return;
            }

            var newRec = context.newRecord;
            var entityId = newRec.getValue({ fieldId: 'entity' });

            if (String(entityId) !== TARGET_CUSTOMER_ID) {
                return;
            }

            processSalesOrder(newRec.id);

        } catch (e) {
            log.error('Customer 27425 EDI SO UE Error', e);
        }
    }

    function getShipMethodFromMemo(memoUpper) {
        for (var i = 0; i < SHIPPING_RULES.length; i++) {
            if (memoUpper.indexOf(SHIPPING_RULES[i].pattern) > -1) {
                return SHIPPING_RULES[i].shipMethod;
            }
        }
        return DEFAULT_SHIP_METHOD;
    }

    /**
     * Single read-only load, single submitFields() write. No full record
     * save is ever performed on this record by this script, so line-level
     * commitment/backorder status and approval routing are never disturbed
     * by the act of updating shipmethod or the packship fields.
     */
    function processSalesOrder(soId) {
        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: soId,
            isDynamic: false
        });

        var memoUpper = String(soRec.getValue({ fieldId: 'memo' }) || '').toUpperCase();
        var isClarkLTL = memoUpper.indexOf(CLARK_LTL_TOKEN) > -1;

        // --- Ship method: submitted on its own so it can never be blocked by
        //     a problem with the packship fields below. ---
        var currentShipMethod = soRec.getValue({ fieldId: 'shipmethod' });
        var desiredShipMethod = getShipMethodFromMemo(memoUpper);
        if (String(currentShipMethod) !== String(desiredShipMethod)) {
            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: soId,
                values: { shipmethod: desiredShipMethod },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            log.audit('Customer 27425 SO - shipmethod updated', {
                salesOrder: soId,
                shipMethod: desiredShipMethod
            });
        }

        // --- Packship / other-party billing fields (CORRECTED field IDs) ---
        var billingType = soRec.getValue({ fieldId: 'custbody_packship_billing_type' });
        var accountNumber = soRec.getValue({ fieldId: 'custbody_packship_account_number' });
        var fieldsPopulated = !!(billingType && accountNumber);

        var packshipValues = null;

        if (isClarkLTL) {
            if (fieldsPopulated) {
                packshipValues = {
                    custbody_packship_billing_type: '',
                    custbody_packship_account_number: '',
                    custbody_packship_country: '',
                    custbody_packship_zip_code: ''
                };
            }
        } else if (!fieldsPopulated) {
            var customerRec = record.load({
                type: record.Type.CUSTOMER,
                id: TARGET_CUSTOMER_ID,
                isDynamic: false
            });

            var thirdPartyAcct = customerRec.getValue({ fieldId: 'thirdpartyacct' });
            var thirdPartyZip = customerRec.getValue({ fieldId: 'thirdpartyzipcode' });
            var thirdPartyCountry = customerRec.getValue({ fieldId: 'thirdpartycountry' });
            var countryId = thirdPartyCountry ? COUNTRY_ID_MAP[String(thirdPartyCountry)] : null;

            if (thirdPartyAcct) {
                packshipValues = {
                    custbody_packship_account_number: thirdPartyAcct,
                    custbody_packship_zip_code: thirdPartyZip,
                    custbody_packship_billing_type: THIRD_PARTY_BILLING_TYPE_ID
                };
                if (countryId) {
                    packshipValues.custbody_packship_country = countryId;
                } else if (thirdPartyCountry) {
                    // Unmapped country code - log it and skip just this one field
                    // rather than let it block account number/zip/billing type.
                    log.audit(
                        'Customer 27425 SO - unmapped country code, country field skipped',
                        { salesOrder: soId, thirdPartyCountry: thirdPartyCountry }
                    );
                }
            } else {
                log.audit(
                    'Customer 27425 SO - third party fields NOT populated',
                    { salesOrder: soId, reason: 'thirdpartyacct is blank on customer record ' + TARGET_CUSTOMER_ID }
                );
            }
        }

        if (packshipValues) {
            try {
                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: soId,
                    values: packshipValues,
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                log.audit('Customer 27425 SO - packship fields updated', {
                    salesOrder: soId,
                    isClarkLTL: isClarkLTL,
                    values: packshipValues
                });
            } catch (packshipError) {
                // Isolated on purpose: a bad value here must never roll back
                // or block the shipmethod update above.
                log.error('Customer 27425 SO - packship fields FAILED', {
                    salesOrder: soId,
                    attemptedValues: packshipValues,
                    error: packshipError
                });
            }
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});