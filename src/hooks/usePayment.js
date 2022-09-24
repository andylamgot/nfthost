import { useRouter } from 'next/router'
import { useToast } from '@chakra-ui/react'
import { useCore } from '@/providers/CoreProvider'
import { useUser } from '@/providers/UserProvider'
import { useWeb3 } from '@/hooks/useWeb3'
import Web3 from 'web3'
import axios from 'axios'
import posthog from 'posthog-js'
import config from '@/config/index'
import { decryptToken, getPriceFromService, getCurrencyFromWallet } from '@/utils/tools'
import * as solanaWeb3 from '@solana/web3.js'
import { getAccessToken } from '@/utils/tools'
import errorHandler from '@/utils/errorHandler'

export const usePayment = () => {
    const router = useRouter();
    const toast = useToast({
        title: 'Error',
        status: 'error',
        duration: 3000,
        isClosable: true,
        position: 'bottom'
    });
    const { user } = useUser();
    const { isNetworkProtected, AddFree, UpdateEmail } = useWeb3();
    const { 
        provider,
        paymentData,
        paymentName,
        paymentEmail,
        paymentAddress,
        paymentCity,
        paymentState,
        paymentZip,
        setIsPaying,
        setIsKeepWorkingModal,
        setPaymentData     
    } = useCore();

    const Pay = (paymentData) => {
        try {
            setPaymentData({
                ...paymentData,
                due: new Date()
            })

            router.push('/payment', undefined, { shallow: true }); 
        }
        catch (err) {
            const msg = errorHandler(err);
            toast({ description: msg });
        }
    }

    const createTransactionSolana = async (connection, provider, instructions) => {
        const anyTransaction = new solanaWeb3.Transaction().add(instructions);
        anyTransaction.feePayer = provider.publicKey;
        anyTransaction.recentBlockhash = (
            await connection.getRecentBlockhash()
        ).blockhash;
        return anyTransaction;
    }

    const PayWithCrypto = async () => {
        try {
            if (!provider) throw new Error('Cannot find web3 provider. Please relogin.');

            const storageToken = localStorage.getItem('nfthost-user');
            if (!storageToken) return;

            const userData = decryptToken(storageToken);
            const wallet = userData.wallet;
            
            const service = paymentData.service.toLowerCase();

            const currency = getCurrencyFromWallet(wallet);
            const price = getPriceFromService(service, currency);

            await isNetworkProtected(wallet);

            setIsPaying(true);

            let hash = 'n/a';

            if (wallet === 'metamask' || wallet === 'coinbase' || wallet === 'walletconnect') {
                const txHash = await window.web3.eth.sendTransaction({
                    from: provider.selectedAddress || userData.address,
                    to: config.nfthost.wallet_metamask,
                    value: Web3.utils.toWei(price.toFixed(7).toString(), 'ether')
                })
                hash = txHash.blockHash;
            } 
            else if (wallet === 'phantom') {
                const connection = new solanaWeb3.Connection(
                    solanaWeb3.clusterApiUrl(process.env.CHAIN_ID === '0x1' ? 'mainnet-beta': 'devnet'), 
                );

                const { signature } = await provider.signAndSendTransaction(await createTransactionSolana(
                    connection,
                    provider,
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: provider.publicKey,
                        toPubkey: config.nfthost.wallet_phantom,
                        lamports: solanaWeb3.LAMPORTS_PER_SOL * price,
                    })
                ));

                await connection.confirmTransaction(signature);
                hash = signature;
            }
            else {
                throw new Error('Your wallet is currently not supported for payment, please login with a different wallet provider')
            }

            posthog.capture('User paid with crypto wallet', {
                wallet
            });

            await AddFree(1, service);
            await addPayment(hash);

            toast({
                title: 'Success',
                description: 'Successfuly Purchased Item',
                status: 'success'
            })

            setIsKeepWorkingModal(true);
            setIsPaying(false);
        }
        catch (err) {
            setIsPaying(false);
            const msg = errorHandler(err);
            toast({ description: msg });
        }
    }

    const PayWithStripe = async (stripe, elements, CardElement) => {
        try {
            setIsPaying(true);

            if (!elements || !stripe) throw new Error('Error initializing stripe payment');

            const fieldsLength = [paymentName.length, paymentEmail.length, paymentAddress.length, paymentCity.length, paymentState.length, paymentZip.length];
            fieldsLength.forEach((field) => {
                if (field === 0) throw new Error("Please fill in all the required fields");
            })

            const re = /^\S+@\S+\.\S+$/
            if (!re.test(paymentEmail)) throw new Error("Email address must be valid");

            const billingDetails = {
                name: paymentName,
                email: paymentEmail,
                address: {
                    city: paymentCity,
                    line1: paymentAddress,
                    state: paymentState,
                    postal_code: paymentZip
                }       
            }

            const accessToken = getAccessToken();
            const service = paymentData.service.toLowerCase();
            const price = getPriceFromService(service); 

            const paymentType = {
                generator: 'onetime',
                utils: 'onetime',
                website: 'subscription'
            }[service];
            
            let clientData;
            if (paymentType === 'subscription') {
                clientData = await axios.post(`${config.serverUrl}/api/payment/requestSubscription`, {
                    service,
                    billingDetails,
                    customerId: user.customerId,
                    metadata: {
                        walletProvider: user.wallet,
                        walletAddress: user.address
                    }
                }, {
                    headers: { 
                        Authorization: `Bearer ${accessToken}` 
                    }
                })
            }
            else {
                clientData = await axios.post(`${config.serverUrl}/api/payment/request`, {
                    billingDetails,
                    amount: price,
                    customerId: user.customerId,
                    metadata: {
                        walletProvider: user.wallet,
                        walletAddress: user.address
                    }
                }, {
                    headers: { 
                        Authorization: `Bearer ${accessToken}` 
                    }
                })
            }

            const cardElement = elements.getElement(CardElement);

            const paymentMethod = await stripe.createPaymentMethod({
                type: 'card',
                card: cardElement,
                billing_details: billingDetails,
            });

            if (paymentMethod.error) throw new Error(paymentMethod.error.code);

            const transaction = await stripe.confirmCardPayment(clientData.data.clientSecret, {
                payment_method: paymentMethod.paymentMethod.id
            });

            if (transaction.error) throw new Error(transaction.error.code);

            posthog.capture('User paid with stripe', {
                price: paymentData.price
            });

            await AddFree(1, service);
            await addPayment(transaction.paymentIntent.id);
            await UpdateEmail(paymentEmail);

            toast({
                title: 'Success',
                description: 'Successfuly Purchased Item',
                status: 'success',
                duration: 3000,
                isClosable: true,
                position: 'bottom-center'
            })

            setIsKeepWorkingModal(true);
            setIsPaying(false);
        }
        catch (err) {
            setIsPaying(false);
            const msg = errorHandler(err);
            toast({ description: msg });
        }
    }

    const addPayment = async (hash) => {
        try {
            const accessToken = getAccessToken();
            const service = paymentData.service.toLowerCase();
            const price = getPriceFromService(service);
    
            await axios.post(`${config.serverUrl}/api/payment/add`, {
                memberId: user._id,
                hash,
                service,
                price,
            }, {
                headers: { 
                    Authorization: `Bearer ${accessToken}` 
                }
            })
        }
        catch (err) {
            const msg = errorHandler(err);
            toast({ description: msg });
        }
    }

    return {
        Pay,
        PayWithCrypto,
        PayWithStripe
    }
}