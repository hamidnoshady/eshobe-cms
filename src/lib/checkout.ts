/**
 * The one number every part of a purchase agrees on.
 *
 * The product card's input, the order field's `max` and the checkout endpoint's
 * validator all enforce the same cap, and three copies of `99` is three chances for
 * one of them to move on its own: an input that allows 200 against a schema that
 * rejects it is a form that fails with a database error, and a schema that allows
 * more than the endpoint does is a rule nobody can rely on.
 */
export const MAX_ORDER_QUANTITY = 99
